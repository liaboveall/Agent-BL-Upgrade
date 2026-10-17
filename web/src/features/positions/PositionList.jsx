export function PositionList({ positions }) {
  if (!positions?.length) return <p>No positions</p>;
  return (
    <table>
      <thead>
        <tr><th>Mode</th><th>Pool</th><th>Shares</th><th>Cost</th><th>Claimable</th><th>Claimed</th><th>Status</th></tr>
      </thead>
      <tbody>
        {positions.map((p, i) => (
          <tr key={i}>
            <td>{p.mode}</td>
            <td>{p.mode === 'live' ? `${p.protocol_instance.pool_address}:${p.chain_pool_id}` : p.pool_id}</td>
            <td>{p.shares}</td>
            <td>{p.cost_usd ?? p.cost_atomic}</td>
            <td>{p.claimable_usd ?? p.claimable_atomic ?? '-'}</td>
            <td>{p.claimed_usd ?? p.claimed_atomic ?? '-'}</td>
            <td>{p.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
