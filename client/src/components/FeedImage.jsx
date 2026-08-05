import { useEffect, useState } from 'react';
import api from '../api/client';

// Feed photos are served as raw bytes from GET /newsfeed/images/:id, which needs the auth
// header -- and an <img src> tag cannot send one. So each image is fetched as a blob through
// the same axios client every other request uses, and handed to the tag as an object URL.
//
// The alternative would be putting the token in the query string, which then lives in server
// logs and browser history for every photo on the page.
//
// Cached for the life of the page: a post scrolled past and back again must not re-download.
// Object URLs are deliberately never revoked -- a revoked one breaks any <img> still pointing
// at it, and the cache is bounded in practice by how many photos one session scrolls past.
const cache = new Map();

export default function FeedImage({ imageId, alt = '', className = '', style, onClick }) {
  const [src, setSrc] = useState(() => cache.get(imageId) || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (cache.has(imageId)) { setSrc(cache.get(imageId)); return undefined; }
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    api.get(`/newsfeed/images/${imageId}`, { responseType: 'blob' })
      .then(({ data }) => {
        const url = URL.createObjectURL(data);
        cache.set(imageId, url);
        if (!cancelled) setSrc(url);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [imageId]);

  if (failed) return <div className={`feed-photo-missing ${className}`} style={style}>Photo unavailable</div>;
  // The placeholder keeps the collage's shape while the bytes are in flight, so the post below
  // does not jump up the page as each photo lands.
  if (!src) return <div className={`feed-photo-loading ${className}`} style={style} />;

  return <img src={src} alt={alt} className={className} style={style} onClick={onClick} />;
}

// 1 photo fills the card; 2 sit side by side; 3 put the first one tall on the left; 4 or more
// tile 2x2 with a +N badge over the last -- the arrangement a Facebook post uses, which is what
// makes a multi-photo post readable at a glance rather than a stack of full-width images.
export function FeedPhotoCollage({ images, onOpen }) {
  if (!images?.length) return null;
  const shown = images.slice(0, 4);
  const extra = images.length - shown.length;
  const layout = shown.length === 1 ? 'one' : shown.length === 2 ? 'two' : shown.length === 3 ? 'three' : 'four';

  return (
    <div className={`feed-collage feed-collage-${layout}`}>
      {shown.map((img, i) => (
        <button
          type="button"
          key={img.id}
          className="feed-collage-cell"
          onClick={() => onOpen?.(i)}
          aria-label={`Open photo ${i + 1}`}
        >
          <FeedImage imageId={img.id} alt="" className="feed-collage-img" />
          {extra > 0 && i === shown.length - 1 && <span className="feed-collage-more">+{extra}</span>}
        </button>
      ))}
    </div>
  );
}

// Full-screen viewer, arrow keys and Esc wired up because a photo post is usually several
// photos and clicking through them is the whole point.
export function FeedLightbox({ images, index, onClose, onIndex }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onIndex((index + 1) % images.length);
      if (e.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onClose, onIndex]);

  const image = images[index];
  if (!image) return null;

  return (
    <div className="feed-lightbox" onClick={onClose}>
      <button type="button" className="feed-lightbox-close" onClick={onClose} aria-label="Close">✕</button>
      {images.length > 1 && (
        <button
          type="button"
          className="feed-lightbox-nav feed-lightbox-prev"
          onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + images.length) % images.length); }}
          aria-label="Previous photo"
        >‹</button>
      )}
      <div className="feed-lightbox-stage" onClick={(e) => e.stopPropagation()}>
        <FeedImage imageId={image.id} alt="" className="feed-lightbox-img" />
      </div>
      {images.length > 1 && (
        <button
          type="button"
          className="feed-lightbox-nav feed-lightbox-next"
          onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % images.length); }}
          aria-label="Next photo"
        >›</button>
      )}
      {images.length > 1 && <div className="feed-lightbox-count">{index + 1} / {images.length}</div>}
    </div>
  );
}
