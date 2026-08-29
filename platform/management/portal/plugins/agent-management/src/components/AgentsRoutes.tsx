import { Route, Routes, useParams } from 'react-router-dom';
import { AgentsPage } from './AgentsPage';
import { AgentDetailPage } from './AgentDetailPage';
import { CreateAgentPage } from './CreateAgentPage';

function AgentDetailRoute() {
  const { agentId } = useParams();
  return <AgentDetailPage agentId={agentId ?? ''} />;
}

/**
 * Editing lives here rather than under /create-agent so it needs no route ref of
 * its own: it is the create wizard prefilled from an existing Agent.
 */
function AgentEditRoute() {
  const { agentId } = useParams();
  return <CreateAgentPage agentId={agentId ?? ''} />;
}

/** Agents directory, agent detail and agent edit, mounted under the Agents nav entry. */
export function AgentsRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AgentsPage />} />
      <Route path="/:agentId" element={<AgentDetailRoute />} />
      <Route path="/:agentId/edit" element={<AgentEditRoute />} />
    </Routes>
  );
}
