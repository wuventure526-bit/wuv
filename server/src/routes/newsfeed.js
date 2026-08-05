const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// The company newsfeed behind the Dashboard. Gated on requireAuth only, deliberately: every
// other module is a document with an owner and a permission row, but the feed is the one place
// in the system that belongs to everybody -- a page/permission gate would mean an account
// could log in and land on a dashboard it is not allowed to read.
//
// Authorship is what is enforced instead: you may edit or delete only your own post or
// comment, and a System Admin may remove anyone's (the moderator case).

const REACTIONS = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'];
const MAX_BODY = 5000;
const MAX_IMAGES = 4;
// Per decoded image. The client resizes to 1600px/JPEG before sending, which lands well under
// this; the cap is here to stop a hand-rolled request putting a 20MB PNG in a MEDIUMBLOB.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function isModerator(userId) {
  const [[u]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  return u?.account_type === 'System Admin';
}

// Feed activity rides the notification table every other module already writes to, so it
// lands in the same bell, the same dropdown and the same toast as a ticket approval -- one
// place to look rather than a second inbox nobody checks.
//
// related_type 'FeedPost' is what the bell keys on to send a click to /dashboard?post=<id>.
const NOTIFY_MESSAGE_MAX = 500;   // notifications.message is VARCHAR(500)

function excerpt(text, max = 120) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Never notifies the person who caused the event -- you do not need telling about your own
// click. Failures are swallowed: a notification is a courtesy, and losing one must never roll
// back the comment or reaction that earned it.
async function notify(recipientIds, { actorId, type, title, message, postId }) {
  const targets = [...new Set(recipientIds)].filter((id) => id && id !== actorId);
  if (!targets.length) return;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES ${targets.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      targets.flatMap((id) => [id, type, title.slice(0, 255), (message || '').slice(0, NOTIFY_MESSAGE_MAX), 'FeedPost', postId])
    );
  } catch (err) {
    console.error('newsfeed notification failed:', err.message);
  }
}

// Everyone with a working login except the poster -- a company announcement is for the
// company. Inactive accounts are skipped so a disabled user does not accrue a backlog.
async function allOtherUserIds(actorId) {
  const [rows] = await pool.query('SELECT id FROM users WHERE is_active = TRUE AND id <> ?', [actorId]);
  return rows.map((r) => r.id);
}

// Whoever has commented on or reacted to a post -- the people with a reason to hear that it
// changed, or that the conversation moved on.
async function postParticipantIds(postId) {
  const [rows] = await pool.query(
    `SELECT author_user_id AS id FROM feed_comments WHERE post_id = ? AND deleted_at IS NULL
     UNION
     SELECT user_id AS id FROM feed_reactions WHERE post_id = ?`,
    [postId, postId]
  );
  return rows.map((r) => r.id);
}

const REACTION_EMOJI = {
  like: '👍', love: '❤️', care: '🤗', haha: '😆', wow: '😮', sad: '😢', angry: '😡',
};

// "data:image/jpeg;base64,...." -> { buffer, mimeType }. Returns null for anything that is not
// a base64 image data URL, so a caller can reject rather than store junk.
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const mimeType = m[1].toLowerCase();
  if (!IMAGE_MIME.includes(mimeType)) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) return null;
  return { buffer, mimeType };
}

// One post's worth of everything the feed card renders, for a batch of post ids: authors,
// photo dimensions (not the bytes), reaction tallies, the viewer's own reaction, and the
// comment count with the two most recent comments. Assembled in four queries for the whole
// page rather than four per post.
async function decoratePosts(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const [images] = await pool.query(
    `SELECT id, post_id, width, height, mime_type FROM feed_post_images
     WHERE post_id IN (?) ORDER BY post_id, sort_order, id`,
    [ids]
  );
  const [reactions] = await pool.query(
    `SELECT post_id, reaction, COUNT(*) AS n, SUM(user_id = ?) AS mine
     FROM feed_reactions WHERE post_id IN (?) GROUP BY post_id, reaction`,
    [viewerId, ids]
  );
  const [commentCounts] = await pool.query(
    `SELECT post_id, COUNT(*) AS n FROM feed_comments
     WHERE post_id IN (?) AND deleted_at IS NULL GROUP BY post_id`,
    [ids]
  );
  // The last two comments per post, the way the feed shows a preview under each card with
  // "View all N comments" above them. Fetched as one window over every post's comments rather
  // than a query per post.
  const [recentComments] = await pool.query(
    `SELECT c.*, u.display_name AS author_name, u.avatar_data AS author_avatar
     FROM feed_comments c
     JOIN users u ON u.id = c.author_user_id
     WHERE c.post_id IN (?) AND c.deleted_at IS NULL
     ORDER BY c.post_id, c.id DESC`,
    [ids]
  );

  const imagesByPost = new Map();
  for (const img of images) {
    if (!imagesByPost.has(img.post_id)) imagesByPost.set(img.post_id, []);
    imagesByPost.get(img.post_id).push({ id: img.id, width: img.width, height: img.height, mime_type: img.mime_type });
  }
  const reactionsByPost = new Map();
  for (const r of reactions) {
    if (!reactionsByPost.has(r.post_id)) reactionsByPost.set(r.post_id, { counts: {}, total: 0, mine: null });
    const entry = reactionsByPost.get(r.post_id);
    entry.counts[r.reaction] = Number(r.n);
    entry.total += Number(r.n);
    if (Number(r.mine) > 0) entry.mine = r.reaction;
  }
  const countByPost = new Map(commentCounts.map((c) => [c.post_id, Number(c.n)]));
  const previewByPost = new Map();
  for (const c of recentComments) {
    const list = previewByPost.get(c.post_id) || [];
    if (list.length < 2) {
      list.push(c);
      previewByPost.set(c.post_id, list);
    }
  }

  return rows.map((p) => ({
    id: p.id,
    body: p.body,
    created_at: p.created_at,
    edited_at: p.edited_at,
    author: { id: p.author_user_id, display_name: p.author_name, avatar_data: p.author_avatar },
    images: imagesByPost.get(p.id) || [],
    reactions: reactionsByPost.get(p.id) || { counts: {}, total: 0, mine: null },
    comment_count: countByPost.get(p.id) || 0,
    // Reversed because the window above ordered newest-first to take the last two; the card
    // reads them oldest-first, like a conversation.
    recent_comments: (previewByPost.get(p.id) || []).slice().reverse().map(shapeComment),
  }));
}

function shapeComment(c) {
  return {
    id: c.id,
    post_id: c.post_id,
    body: c.body,
    created_at: c.created_at,
    edited_at: c.edited_at,
    author: { id: c.author_user_id, display_name: c.author_name, avatar_data: c.author_avatar },
  };
}

// Cursor paging on id rather than OFFSET: the feed grows from the top while it is being read,
// and an offset would repeat or skip a post every time someone posts mid-scroll.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10));
    const before = Number(req.query.before) || null;

    const where = ['p.deleted_at IS NULL'];
    const params = [];
    if (before) { where.push('p.id < ?'); params.push(before); }

    const [rows] = await pool.query(
      `SELECT p.*, u.display_name AS author_name, u.avatar_data AS author_avatar
       FROM feed_posts p
       JOIN users u ON u.id = p.author_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.id DESC
       LIMIT ?`,
      [...params, limit + 1]
    );

    const page = rows.slice(0, limit);
    const posts = await decoratePosts(page, req.user.id);
    const moderator = await isModerator(req.user.id);
    posts.forEach((p) => { p.can_manage = moderator || p.author.id === req.user.id; });

    res.json({
      posts,
      // The extra row fetched above answers "is there more" without a second COUNT query.
      next_before: rows.length > limit ? page[page.length - 1].id : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    const images = Array.isArray(req.body.images) ? req.body.images : [];

    if (!body && !images.length) return res.status(400).json({ error: 'Write something or add a photo.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: `Keep a post under ${MAX_BODY} characters.` });
    if (images.length > MAX_IMAGES) return res.status(400).json({ error: `A post can carry up to ${MAX_IMAGES} photos.` });

    // Every image is validated BEFORE anything is written, so a bad third photo cannot leave a
    // half-built post behind.
    const parsed = [];
    for (const img of images) {
      const file = parseDataUrl(img?.data_url ?? img);
      if (!file) return res.status(400).json({ error: 'One of those files is not a JPEG, PNG, WebP or GIF image.' });
      if (file.buffer.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'One of those photos is too large.' });
      parsed.push({ ...file, width: Number(img?.width) || null, height: Number(img?.height) || null });
    }

    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO feed_posts (author_user_id, body) VALUES (?, ?)',
      [req.user.id, body || null]
    );
    const postId = result.insertId;

    let sortOrder = 0;
    for (const file of parsed) {
      await conn.query(
        `INSERT INTO feed_post_images (post_id, sort_order, mime_type, width, height, byte_size, image_data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [postId, sortOrder, file.mimeType, file.width, file.height, file.buffer.length, file.buffer]
      );
      sortOrder += 1;
    }
    await conn.commit();

    const [rows] = await pool.query(
      `SELECT p.*, u.display_name AS author_name, u.avatar_data AS author_avatar
       FROM feed_posts p JOIN users u ON u.id = p.author_user_id WHERE p.id = ?`,
      [postId]
    );
    const [post] = await decoratePosts(rows, req.user.id);
    post.can_manage = true;

    const photoNote = parsed.length ? `${parsed.length} photo${parsed.length === 1 ? '' : 's'}` : '';
    await notify(await allOtherUserIds(req.user.id), {
      actorId: req.user.id,
      type: 'feed_new_post',
      title: `${post.author.display_name} posted on the feed`,
      message: excerpt(body) || (photoNote ? `Shared ${photoNote}` : ''),
      postId,
    });

    res.status(201).json(post);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Editing changes the words only. Re-attaching photos would mean deciding what happens to the
// reactions and comments the original picture drew, so a post's photos are fixed once posted --
// the same rule the real thing applies to an edited post's attachments.
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (body.length > MAX_BODY) return res.status(400).json({ error: `Keep a post under ${MAX_BODY} characters.` });

    const [[post]] = await pool.query('SELECT * FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (post.author_user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own post.' });

    const [[imgCount]] = await pool.query('SELECT COUNT(*) AS n FROM feed_post_images WHERE post_id = ?', [post.id]);
    if (!body && !imgCount.n) return res.status(400).json({ error: 'A post cannot be left empty.' });

    await pool.query('UPDATE feed_posts SET body = ?, edited_at = NOW() WHERE id = ?', [body || null, post.id]);

    const [rows] = await pool.query(
      `SELECT p.*, u.display_name AS author_name, u.avatar_data AS author_avatar
       FROM feed_posts p JOIN users u ON u.id = p.author_user_id WHERE p.id = ?`,
      [post.id]
    );
    const [shaped] = await decoratePosts(rows, req.user.id);
    shaped.can_manage = true;

    // Only the author can edit, so telling them is pointless -- the people who need to know a
    // post changed are the ones who already commented on it or reacted to it, whose response
    // is attached to wording that has now moved.
    await notify(await postParticipantIds(post.id), {
      actorId: req.user.id,
      type: 'feed_post_updated',
      title: `${shaped.author.display_name} updated a post you responded to`,
      message: excerpt(body),
      postId: post.id,
    });

    res.json(shaped);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const [[post]] = await pool.query('SELECT * FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (post.author_user_id !== req.user.id && !(await isModerator(req.user.id))) {
      return res.status(403).json({ error: 'You can only delete your own post.' });
    }
    await pool.query('UPDATE feed_posts SET deleted_at = NOW(), deleted_by_user_id = ? WHERE id = ?', [req.user.id, post.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Photos are served one at a time as raw bytes instead of riding inside the feed JSON as
// base64 -- it keeps the feed response small, lets the browser stream them as they scroll into
// view, and means a post with four photos is four cacheable requests rather than one huge one.
router.get('/images/:id', requireAuth, async (req, res, next) => {
  try {
    const [[img]] = await pool.query(
      `SELECT i.mime_type, i.image_data FROM feed_post_images i
       JOIN feed_posts p ON p.id = i.post_id
       WHERE i.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!img) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', img.mime_type);
    // Immutable: an image row is never rewritten, only deleted with its post. Private, because
    // the bytes are only for a signed-in colleague -- never a shared proxy cache.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(img.image_data);
  } catch (err) {
    next(err);
  }
});

// One post on its own. A notification can point at a post that is far down the feed -- by the
// time you click it, ten newer posts may sit above it -- so the bell's link fetches it
// directly instead of paging until it appears.
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, u.display_name AS author_name, u.avatar_data AS author_avatar
       FROM feed_posts p JOIN users u ON u.id = p.author_user_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'That post is no longer available.' });
    const [post] = await decoratePosts(rows, req.user.id);
    post.can_manage = (await isModerator(req.user.id)) || post.author.id === req.user.id;
    res.json(post);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, u.display_name AS author_name, u.avatar_data AS author_avatar
       FROM feed_comments c
       JOIN users u ON u.id = c.author_user_id
       WHERE c.post_id = ? AND c.deleted_at IS NULL
       ORDER BY c.id`,
      [req.params.id]
    );
    const moderator = await isModerator(req.user.id);
    res.json(rows.map((c) => ({
      ...shapeComment(c),
      can_manage: moderator || c.author_user_id === req.user.id,
    })));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'Write a comment first.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: `Keep a comment under ${MAX_BODY} characters.` });

    const [[post]] = await pool.query('SELECT id, author_user_id FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'That post is no longer available.' });

    const [result] = await pool.query(
      'INSERT INTO feed_comments (post_id, author_user_id, body) VALUES (?, ?, ?)',
      [post.id, req.user.id, body]
    );
    const [[row]] = await pool.query(
      `SELECT c.*, u.display_name AS author_name, u.avatar_data AS author_avatar
       FROM feed_comments c JOIN users u ON u.id = c.author_user_id WHERE c.id = ?`,
      [result.insertId]
    );

    await notify([post.author_user_id], {
      actorId: req.user.id,
      type: 'feed_comment',
      title: `${row.author_name} commented on your post`,
      message: excerpt(body),
      postId: post.id,
    });

    res.status(201).json({ ...shapeComment(row), can_manage: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const [[comment]] = await pool.query('SELECT * FROM feed_comments WHERE id = ? AND deleted_at IS NULL', [req.params.commentId]);
    if (!comment) return res.status(404).json({ error: 'Not found' });
    if (comment.author_user_id !== req.user.id && !(await isModerator(req.user.id))) {
      return res.status(403).json({ error: 'You can only delete your own comment.' });
    }
    await pool.query('UPDATE feed_comments SET deleted_at = NOW(), deleted_by_user_id = ? WHERE id = ?', [req.user.id, comment.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// One reaction per person per post: sending a different one MOVES it (the unique key's upsert),
// and sending the one already set clears it -- which is exactly what clicking Like twice does.
router.put('/:id/reaction', requireAuth, async (req, res, next) => {
  try {
    const reaction = String(req.body.reaction || '').toLowerCase();
    if (!REACTIONS.includes(reaction)) return res.status(400).json({ error: 'Unknown reaction.' });

    const [[post]] = await pool.query('SELECT id, author_user_id FROM feed_posts WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'That post is no longer available.' });

    const [[existing]] = await pool.query(
      'SELECT id, reaction FROM feed_reactions WHERE post_id = ? AND user_id = ?',
      [post.id, req.user.id]
    );
    if (existing && existing.reaction === reaction) {
      await pool.query('DELETE FROM feed_reactions WHERE id = ?', [existing.id]);
    } else if (existing) {
      await pool.query('UPDATE feed_reactions SET reaction = ?, updated_at = NOW() WHERE id = ?', [reaction, existing.id]);
    } else {
      await pool.query('INSERT INTO feed_reactions (post_id, user_id, reaction) VALUES (?, ?, ?)', [post.id, req.user.id, reaction]);
      // Only the FIRST reaction from this person notifies. Swapping Like for Love, or
      // clearing and re-picking, is the same person still reacting once -- one bell for it,
      // not one per change of mind.
      const [[actor]] = await pool.query('SELECT display_name FROM users WHERE id = ?', [req.user.id]);
      await notify([post.author_user_id], {
        actorId: req.user.id,
        type: 'feed_reaction',
        title: `${actor?.display_name || 'Someone'} reacted ${REACTION_EMOJI[reaction] || ''} to your post`.trim(),
        message: '',
        postId: post.id,
      });
    }

    res.json(await reactionSummary(post.id, req.user.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/reaction', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM feed_reactions WHERE post_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json(await reactionSummary(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
});

// Who reacted, for the hover/click list behind the reaction pills.
router.get('/:id/reactions', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.reaction, r.created_at, u.id AS user_id, u.display_name, u.avatar_data
       FROM feed_reactions r JOIN users u ON u.id = r.user_id
       WHERE r.post_id = ? ORDER BY r.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

async function reactionSummary(postId, viewerId) {
  const [rows] = await pool.query(
    `SELECT reaction, COUNT(*) AS n, SUM(user_id = ?) AS mine
     FROM feed_reactions WHERE post_id = ? GROUP BY reaction`,
    [viewerId, postId]
  );
  const summary = { counts: {}, total: 0, mine: null };
  for (const r of rows) {
    summary.counts[r.reaction] = Number(r.n);
    summary.total += Number(r.n);
    if (Number(r.mine) > 0) summary.mine = r.reaction;
  }
  return summary;
}

module.exports = router;
