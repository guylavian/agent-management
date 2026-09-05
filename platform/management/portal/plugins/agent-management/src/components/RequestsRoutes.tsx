import { Route, Routes, useParams } from 'react-router-dom';
import { RequestDetailPage, RequestsPage } from './RequestsPage';

function RequestDetailRoute() {
  const { requestId } = useParams();
  return <RequestDetailPage requestId={requestId ?? ''} />;
}

/** Requests list plus the execution graph for one request — the Runs layout, for changes. */
export function RequestsRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RequestsPage />} />
      <Route path="/:requestId" element={<RequestDetailRoute />} />
    </Routes>
  );
}
