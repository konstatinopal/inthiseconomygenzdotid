import { useNavigate } from 'react-router-dom';
import { useQuery } from '../lib/hooks';

export function TagsPage() {
  const tags = useQuery<{ tag: string; count: number }[]>('tags-get', {}, ['transactions']);
  const navigate = useNavigate();
  return (
    <div className="page">
      <div className="page-header">
        <h1>Tags</h1>
        <span className="muted small">Write #tags in transaction notes. Click a tag to see its transactions.</span>
      </div>
      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>Tag</th>
              <th className="num">Transactions</th>
            </tr>
          </thead>
          <tbody>
            {(tags.data ?? []).map(t => (
              <tr key={t.tag} style={{ cursor: 'pointer' }} onClick={() => navigate(`/accounts?search=${encodeURIComponent(t.tag)}`)}>
                <td>
                  <span className="tag">{t.tag}</span>
                </td>
                <td className="num">{t.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tags.data?.length === 0 && <div className="empty">No tags yet. Add something like “#vacation” to a transaction’s notes.</div>}
      </div>
    </div>
  );
}
