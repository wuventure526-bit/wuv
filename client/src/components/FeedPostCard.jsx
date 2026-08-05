import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { FeedPhotoCollage, FeedLightbox } from './FeedImage';
import { parseUtc } from '../utils/datetime';

// The seven reactions, in the order the hover picker lays them out. Colours come from the
// system's own theme tokens rather than Facebook's palette -- the shape is theirs, the colour
// is ours.
export const REACTIONS = [
  { key: 'like', emoji: '👍', label: 'Like', color: 'var(--accent)' },
  { key: 'love', emoji: '❤️', label: 'Love', color: 'var(--danger)' },
  { key: 'care', emoji: '🤗', label: 'Care', color: 'var(--gold)' },
  { key: 'haha', emoji: '😆', label: 'Haha', color: 'var(--gold)' },
  { key: 'wow', emoji: '😮', label: 'Wow', color: 'var(--gold)' },
  { key: 'sad', emoji: '😢', label: 'Sad', color: 'var(--gold)' },
  { key: 'angry', emoji: '😡', label: 'Angry', color: 'var(--danger)' },
];
const REACTION_BY_KEY = Object.fromEntries(REACTIONS.map((r) => [r.key, r]));

function timeAgo(value) {
  if (!value) return '';
  const diffMs = Date.now() - parseUtc(value).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return parseUtc(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Comment({ comment, onDelete }) {
  return (
    <div className="feed-comment">
      <Avatar user={comment.author} size={32} />
      <div className="feed-comment-body">
        <div className="feed-comment-bubble">
          <div className="feed-comment-author">{comment.author.display_name}</div>
          <div className="feed-comment-text">{comment.body}</div>
        </div>
        <div className="feed-comment-meta">
          <span>{timeAgo(comment.created_at)}</span>
          {comment.can_manage && (
            <button type="button" className="feed-link-btn" onClick={() => onDelete(comment.id)}>Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FeedPostCard({ post, viewer, onChanged, onRemoved }) {
  const [reactions, setReactions] = useState(post.reactions);
  const [comments, setComments] = useState(post.recent_comments || []);
  const [commentCount, setCommentCount] = useState(post.comment_count || 0);
  const [allLoaded, setAllLoaded] = useState((post.comment_count || 0) <= (post.recent_comments || []).length);
  const [draft, setDraft] = useState('');
  const [showComments, setShowComments] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(post.body || '');
  const [lightbox, setLightbox] = useState(-1);
  const [error, setError] = useState('');
  const pickerTimer = useRef(null);

  useEffect(() => () => clearTimeout(pickerTimer.current), []);

  const mine = reactions?.mine ? REACTION_BY_KEY[reactions.mine] : null;
  // Top three by count, which is what the little stack of emoji in front of the tally shows.
  const topReactions = Object.entries(reactions?.counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key]) => REACTION_BY_KEY[key])
    .filter(Boolean);

  async function react(key) {
    setPickerOpen(false);
    try {
      const { data } = await api.put(`/newsfeed/${post.id}/reaction`, { reaction: key });
      setReactions(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that reaction.');
    }
  }

  async function loadAllComments() {
    try {
      const { data } = await api.get(`/newsfeed/${post.id}/comments`);
      setComments(data);
      setCommentCount(data.length);
      setAllLoaded(true);
      setShowComments(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the comments.');
    }
  }

  async function addComment(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    try {
      const { data } = await api.post(`/newsfeed/${post.id}/comments`, { body });
      setComments((prev) => [...prev, data]);
      setCommentCount((n) => n + 1);
      setDraft('');
      setShowComments(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not post that comment.');
    }
  }

  async function deleteComment(commentId) {
    try {
      await api.delete(`/newsfeed/comments/${commentId}`);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      setCommentCount((n) => Math.max(0, n - 1));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete that comment.');
    }
  }

  async function saveEdit() {
    try {
      const { data } = await api.put(`/newsfeed/${post.id}`, { body: editBody });
      setEditing(false);
      onChanged?.(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that change.');
    }
  }

  async function removePost() {
    if (!confirm('Delete this post? Its comments go with it.')) return;
    try {
      await api.delete(`/newsfeed/${post.id}`);
      onRemoved?.(post.id);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete that post.');
    }
  }

  // Hover opens the picker, and a short delay on leaving keeps it open long enough to travel
  // from the Like button up to the emoji row without it vanishing mid-move.
  function openPicker() { clearTimeout(pickerTimer.current); setPickerOpen(true); }
  function closePickerSoon() { pickerTimer.current = setTimeout(() => setPickerOpen(false), 320); }

  const hiddenComments = Math.max(0, commentCount - comments.length);

  return (
    <div className="feed-card feed-post">
      <div className="feed-post-header">
        <Avatar user={post.author} size={40} />
        <div className="feed-post-ident">
          <div className="feed-post-author">{post.author.display_name}</div>
          <div className="feed-post-time">
            {timeAgo(post.created_at)}
            {post.edited_at && <span className="feed-post-edited"> · Edited</span>}
          </div>
        </div>
        {post.can_manage && (
          <div className="feed-post-menu-wrap">
            <button type="button" className="feed-icon-btn" onClick={() => setMenuOpen((s) => !s)} aria-label="Post options">⋯</button>
            {menuOpen && (
              <div className="feed-post-menu">
                {post.author.id === viewer?.id && (
                  <button type="button" onClick={() => { setMenuOpen(false); setEditing(true); setEditBody(post.body || ''); }}>Edit post</button>
                )}
                <button type="button" className="feed-menu-danger" onClick={() => { setMenuOpen(false); removePost(); }}>Delete post</button>
              </div>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div className="feed-post-edit">
          <textarea rows={3} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
          <div className="feed-composer-submit">
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={saveEdit}>Save</button>
          </div>
        </div>
      ) : (
        post.body && <div className="feed-post-body">{post.body}</div>
      )}

      <FeedPhotoCollage images={post.images} onOpen={(i) => setLightbox(i)} />
      {lightbox >= 0 && (
        <FeedLightbox images={post.images} index={lightbox} onClose={() => setLightbox(-1)} onIndex={setLightbox} />
      )}

      {error && <div className="feed-post-error">{error}</div>}

      {(reactions?.total > 0 || commentCount > 0) && (
        <div className="feed-post-stats">
          <div className="feed-stat-reactions">
            {topReactions.map((r) => (
              <span className="feed-stat-emoji" key={r.key} title={r.label}>{r.emoji}</span>
            ))}
            {reactions?.total > 0 && <span className="feed-stat-count">{reactions.total}</span>}
          </div>
          {commentCount > 0 && (
            <button type="button" className="feed-link-btn" onClick={() => (allLoaded ? setShowComments((s) => !s) : loadAllComments())}>
              {commentCount} comment{commentCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      <div className="feed-post-actions">
        <div className="feed-action-wrap" onMouseEnter={openPicker} onMouseLeave={closePickerSoon}>
          <button
            type="button"
            className={`feed-action-btn ${mine ? 'is-active' : ''}`}
            style={mine ? { color: mine.color } : undefined}
            onClick={() => react(mine ? mine.key : 'like')}
          >
            <span className="feed-action-icon" aria-hidden>{mine ? mine.emoji : '👍'}</span>
            {mine ? mine.label : 'Like'}
          </button>
          {pickerOpen && (
            <div className="feed-reaction-picker" onMouseEnter={openPicker} onMouseLeave={closePickerSoon}>
              {REACTIONS.map((r) => (
                <button type="button" key={r.key} title={r.label} className="feed-reaction-option" onClick={() => react(r.key)}>
                  <span aria-hidden>{r.emoji}</span>
                  <span className="feed-reaction-label">{r.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="feed-action-btn" onClick={() => setShowComments((s) => !s)}>
          <span className="feed-action-icon" aria-hidden>💬</span> Comment
        </button>
      </div>

      {(showComments || comments.length > 0) && (
        <div className="feed-comments">
          {hiddenComments > 0 && !allLoaded && (
            <button type="button" className="feed-link-btn feed-view-more" onClick={loadAllComments}>
              View {hiddenComments} more comment{hiddenComments === 1 ? '' : 's'}
            </button>
          )}
          {comments.map((c) => <Comment key={c.id} comment={c} onDelete={deleteComment} />)}
          <form className="feed-comment-form" onSubmit={addComment}>
            <Avatar user={viewer} size={32} />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Write a comment..."
              aria-label="Write a comment"
            />
            <button type="submit" className="feed-comment-send" disabled={!draft.trim()} aria-label="Post comment">➤</button>
          </form>
        </div>
      )}
    </div>
  );
}
