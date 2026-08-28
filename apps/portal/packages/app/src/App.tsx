import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import agentManagementPlugin from '@sre/backstage-plugin-agent-management';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';

export default createApp({
  features: [catalogPlugin, agentManagementPlugin, navModule, homeModule],
});
