import { useRef, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { fileToDataUrl } from '../utils/image';
import LoadingSpinner from './LoadingSpinner';

const MAX_IMAGES = 4;

// The "What's on your mind?" box at the top of the feed. Collapsed it is a single line; the
// first click opens the textarea and the photo tray, which keeps the feed itself the thing you
// see first rather than a permanently open form.
export default function FeedComposer({ user, onPosted }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState([]);   // { data_url, width, height, name }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const firstName = (user?.display_name || '').trim().split(/\s+/)[0] || 'there';

  async function handleFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setError('');
    const room = MAX_IMAGES - photos.length;
    if (room <= 0) { setError(`A post can carry up to ${MAX_IMAGES} photos.`); return; }
    try {
      // Resized in the browser before it is ever held in state, so picking five 8MP photos
      // does not park 40MB in memory waiting for a Post click.
      const shrunk = await Promise.all(files.slice(0, room).map(async (f) => ({ ...(await fileToDataUrl(f)), name: f.name })));
      setPhotos((prev) => [...prev, ...shrunk]);
      if (files.length > room) setError(`Only the first ${room} photo${room === 1 ? '' : 's'} were added -- ${MAX_IMAGES} is the limit.`);
    } catch (err) {
      setError(err.message || 'Could not read that image.');
    }
  }

  async function submit() {
    if (!body.trim() && !photos.length) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await api.post('/newsfeed', {
        body,
        images: photos.map((p) => ({ data_url: p.data_url, width: p.width, height: p.height })),
      });
      setBody('');
      setPhotos([]);
      setOpen(false);
      onPosted?.(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not publish that post.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="feed-card feed-composer">
      <div className="feed-composer-top">
        <Avatar user={user} size={40} />
        {open ? (
          <textarea
            className="feed-composer-textarea"
            autoFocus
            rows={3}
            placeholder={`What's on your mind, ${firstName}?`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        ) : (
          <button type="button" className="feed-composer-trigger" onClick={() => setOpen(true)}>
            What&apos;s on your mind, {firstName}?
          </button>
        )}
      </div>

      {photos.length > 0 && (
        <div className="feed-composer-photos">
          {photos.map((p, i) => (
            <div className="feed-composer-photo" key={`${p.name}-${i}`}>
              <img src={p.data_url} alt={p.name} />
              <button
                type="button"
                className="feed-composer-photo-remove"
                onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove photo"
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="feed-composer-error">{error}</div>}

      <div className="feed-composer-actions">
        <button type="button" className="feed-action-btn" onClick={() => { setOpen(true); fileRef.current?.click(); }}>
          <span className="feed-action-icon" aria-hidden>🖼️</span> Photo
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={handleFiles}
          style={{ display: 'none' }}
        />
        {open && (
          <div className="feed-composer-submit">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => { setOpen(false); setBody(''); setPhotos([]); setError(''); }}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={submit}
              disabled={saving || (!body.trim() && !photos.length)}
            >
              {saving ? <LoadingSpinner inline size="sm" label="Posting..." /> : 'Post'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
