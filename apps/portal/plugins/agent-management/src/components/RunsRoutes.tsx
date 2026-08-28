import { Route, Routes, useParams } from 'react-router-dom';
import { RunDetailPage, RunsPage } from './RunsPage';

function RunDetailRoute() {
  const { runId } = useParams();
  return <RunDetailPage runId={runId ?? ''} />;
}

/** Runs list plus the execution graph for one run. */
export function RunsRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RunsPage />} />
      <Route path="/:runId" element={<RunDetailRoute />} />
    </Routes>
  );
}
