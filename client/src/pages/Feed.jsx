import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Avatar from '../components/Avatar';
import FeedComposer from '../components/FeedComposer';
import FeedPostCard from '../components/FeedPostCard';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';

// The company newsfeed that now fronts the Dashboard: the three-column Facebook layout --
// profile and shortcuts on the left, the feed itself down the middle, a company panel on the
// right -- rendered in the system's own moss-green and gold rather than Facebook's blue.
//
// The analytics dashboard this replaced is not gone: it moved to /dashboard/analytics and is
// linked from the left rail, since a newsfeed answers "what is everyone up to" and those charts
// answer "how is the business doing" -- different questions, both still worth a page.
const SHORTCUTS = [
  { to: '/dashboard/analytics', icon: '📊', label: 'Analytics Dashboard' },
  { to: '/tickets', icon: '🎫', label: 'Tickets' },
  { to: '/sales-orders', icon: '🧾', label: 'Sales Orders' },
  { to: '/job-orders', icon: '🛠️', label: 'Job Orders' },
  { to: '/reports/general-ledger', icon: '📒', label: 'General Ledger' },
];

export default function Feed() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [posts, setPosts] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (before = null) => {
    const { data } = await api.get('/newsfeed', { params: { limit: 10, ...(before ? { before } : {}) } });
    return data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (cancelled) return;
        setPosts(data.posts);
        setNextBefore(data.next_before);
      })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || 'Could not load the feed.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  async function loadMore() {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await load(nextBefore);
      // Appended by id, and de-duplicated: someone posting while you read shifts nothing here
      // (the cursor is an id, not an offset), but a double-click on Load More would otherwise
      // append the same page twice.
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...data.posts.filter((p) => !seen.has(p.id))];
      });
      setNextBefore(data.next_before);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load more posts.');
    } finally {
      setLoadingMore(false);
    }
  }

  function handlePosted(post) { setPosts((prev) => [post, ...prev]); }
  function handleChanged(post) { setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, ...post } : p))); }
  function handleRemoved(id) { setPosts((prev) => prev.filter((p) => p.id !== id)); }

  return (
    <div className="feed-layout">
      <aside className="feed-rail feed-rail-left">
        <div className="feed-card feed-profile">
          <Avatar user={user} size={72} editable />
          <div className="feed-profile-name">{user?.display_name}</div>
          <div className="feed-profile-role">{user?.account_type || 'Team Member'}</div>
        </div>

        <nav className="feed-card feed-shortcuts">
          <div className="feed-rail-title">Shortcuts</div>
          {SHORTCUTS.map((s) => (
            <Link className="feed-shortcut" to={s.to} key={s.to}>
              <span className="feed-shortcut-icon" aria-hidden>{s.icon}</span>
              {s.label}
            </Link>
          ))}
        </nav>
      </aside>

      <main className="feed-main">
        <FeedComposer user={user} onPosted={handlePosted} />

        {error && <div className="error-banner">{error}</div>}

        {loading && <LoadingSpinner />}

        {!loading && posts.length === 0 && (
          <div className="feed-card feed-empty">
            <div className="feed-empty-icon" aria-hidden>📣</div>
            <div className="feed-empty-title">Nothing here yet</div>
            <div className="feed-empty-text">Be the first to post something for {COMPANY.short}.</div>
          </div>
        )}

        {posts.map((post) => (
          <FeedPostCard
            key={post.id}
            post={post}
            viewer={user}
            onChanged={handleChanged}
            onRemoved={handleRemoved}
          />
        ))}

        {nextBefore && (
          <button type="button" className="btn feed-load-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <LoadingSpinner inline size="sm" label="Loading..." /> : 'Load more posts'}
          </button>
        )}
      </main>

      <aside className="feed-rail feed-rail-right">
        <div className="feed-card feed-about">
          <div className="feed-rail-title">{COMPANY.name}</div>
          <p className="feed-about-text">
            Company feed — announcements, milestones and everything the team wants everyone to see.
          </p>
          <button type="button" className="btn btn-sm" onClick={() => navigate('/dashboard/analytics')}>
            Open Analytics Dashboard
          </button>
        </div>

        <div className="feed-card feed-guide">
          <div className="feed-rail-title">Posting here</div>
          <ul className="feed-guide-list">
            <li>Up to 4 photos per post.</li>
            <li>React with 👍 ❤️ 🤗 😆 😮 😢 😡 — hold the Like button.</li>
            <li>You can edit or delete anything you posted.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
