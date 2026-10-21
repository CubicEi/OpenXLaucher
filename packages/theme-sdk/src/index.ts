export type {
  CoreRouteId,
  CoreSlotId,
  JsonValue,
  OpenXLauncherThemeSDK,
  ThemeContext,
  ThemeDefinition,
  ThemeLifecycle,
  ThemeManifest,
  ThemeRouteComponentProps,
  ThemeSlotComponentProps,
} from "../../../lib/themes/protocol";

import type { ThemeDefinition } from "../../../lib/themes/protocol";

export function defineTheme<T extends ThemeDefinition>(definition: T): T {
  return definition;
}
