import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { ThemeBlueprint } from '@backstage/plugin-app-react';
import { UnifiedThemeProvider, createUnifiedTheme, defaultTypography, palettes } from '@backstage/theme';

/**
 * Product theme.
 *
 * Figtree is the UI typeface for everything, including the Backstage-rendered
 * chrome (sign-in, settings, catalog), so the shell does not visibly change
 * font when a user leaves the Agent Management screens.
 *
 * Technical values — model names, endpoints, client ids, audiences, versions,
 * timestamps and durations — use the system monospace stack instead, so an
 * operator can tell an identifier from prose at a glance.
 */
export const UI_FONT = "'Figtree', Helvetica, Arial, sans-serif";
export const MONO_FONT = 'ui-monospace, Menlo, monospace';

const agentOpsTheme = createUnifiedTheme({
  palette: palettes.light,
  fontFamily: UI_FONT,
  typography: {
    fontFamily: UI_FONT,
    htmlFontSize: 16,
    // spread Backstage's defaults so only the family and weight are overridden;
    // the heading scale and spacing stay whatever the platform ships
    h1: { ...defaultTypography.h1, fontFamily: UI_FONT, fontWeight: 800 },
    h2: { ...defaultTypography.h2, fontFamily: UI_FONT, fontWeight: 800 },
    h3: { ...defaultTypography.h3, fontFamily: UI_FONT, fontWeight: 700 },
    h4: { ...defaultTypography.h4, fontFamily: UI_FONT, fontWeight: 700 },
    h5: { ...defaultTypography.h5, fontFamily: UI_FONT, fontWeight: 700 },
    h6: { ...defaultTypography.h6, fontFamily: UI_FONT, fontWeight: 700 },
  },
});

export const themeModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    ThemeBlueprint.make({
      name: 'agentops',
      params: {
        theme: {
          id: 'agentops',
          title: 'AgentOps',
          variant: 'light',
          Provider: ({ children }) => (
            <UnifiedThemeProvider theme={agentOpsTheme}>
              {children}
            </UnifiedThemeProvider>
          ),
        },
      },
    }),
  ],
});
