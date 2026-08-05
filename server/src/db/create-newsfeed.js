// The Dashboard becomes a company newsfeed: staff post updates with photos, react to them
// and comment, the way a Facebook feed works.
//
// Four tables rather than one JSON blob per post, because every part of a post is queried on
// its own: the feed pages over posts, reactions are counted and de-duplicated per user, and
// comments are fetched per post.
//
// Images are MEDIUMBLOB rather than a base64 data URL in TEXT (the shape users.avatar_data
// uses). An avatar is a 240px square measured in kilobytes and rides along in the login
// payload; a feed photo is up to 1600px, and inlining ten posts' worth of base64 into one JSON
// response would put megabytes on the wire before a single image is on screen. Stored as bytes
// they are served one at a time from their own endpoint, and cost a third less to store.
//
// Posts and comments are SOFT deleted. A hard DELETE would take a post's comment thread with
// it -- other people's writing, removed by someone else's click -- and leave nothing to audit.
const pool = require('../db');

async function tableExists(name) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
  );
  return row.n > 0;
}

const TABLES = [
  ['feed_posts', `CREATE TABLE feed_posts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    author_user_id BIGINT NOT NULL,
    body TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at DATETIME NULL,
    deleted_at DATETIME NULL,
    deleted_by_user_id BIGINT NULL,
    KEY idx_feed_posts_live (deleted_at, id),
    KEY idx_feed_posts_author (author_user_id)
  )`],

  // sort_order keeps the photos in the order they were picked; the feed's collage layout
  // (1 big / 2 side-by-side / 2x2 with a +N overlay) depends on that order being stable.
  ['feed_post_images', `CREATE TABLE feed_post_images (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    post_id BIGINT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    mime_type VARCHAR(40) NOT NULL DEFAULT 'image/jpeg',
    width INT NULL,
    height INT NULL,
    byte_size INT NULL,
    image_data MEDIUMBLOB NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_feed_images_post (post_id, sort_order)
  )`],

  ['feed_comments', `CREATE TABLE feed_comments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    post_id BIGINT NOT NULL,
    author_user_id BIGINT NOT NULL,
    body TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at DATETIME NULL,
    deleted_at DATETIME NULL,
    deleted_by_user_id BIGINT NULL,
    KEY idx_feed_comments_post (post_id, deleted_at, id)
  )`],

  // One row per (post, user): a reaction REPLACES that person's previous one rather than
  // adding to it, which is what the unique key enforces -- clicking Love after Like moves the
  // reaction, it does not count twice.
  ['feed_reactions', `CREATE TABLE feed_reactions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    post_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    reaction ENUM('like', 'love', 'care', 'haha', 'wow', 'sad', 'angry') NOT NULL DEFAULT 'like',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uniq_feed_reaction (post_id, user_id),
    KEY idx_feed_reactions_post (post_id, reaction)
  )`],
];

(async () => {
  try {
    for (const [name, ddl] of TABLES) {
      if (await tableExists(name)) {
        console.log(`${name} already present -- skipped`);
      } else {
        await pool.query(ddl);
        console.log(`${name} created`);
      }
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
