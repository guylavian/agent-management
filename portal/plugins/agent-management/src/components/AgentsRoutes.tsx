import { Route, Routes, useParams } from 'react-router-dom';
import { AgentsPage } from './AgentsPage';
import { AgentDetailPage } from './AgentDetailPage';

function AgentDetailRoute() {
  const { agentId } = useParams();
  return <AgentDetailPage agentId={agentId ?? ''} />;
}

/** Agents directory plus agent detail, mounted under the Agents nav entry. */
export function AgentsRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AgentsPage />} />
      <Route path="/:agentId" element={<AgentDetailRoute />} />
    </Routes>
  );
}
