import {
  SETTINGS_CARD_CONTENT_METADATA,
  SETTINGS_CARD_HTML,
  SETTINGS_CARD_RESOURCE_DESCRIPTOR,
  SETTINGS_CARD_URI
} from "../src/settingsCard.js";
import {
  DASHBOARD_CARD_CONTENT_METADATA,
  DASHBOARD_CARD_HTML,
  DASHBOARD_CARD_RESOURCE_DESCRIPTOR,
  DASHBOARD_CARD_URI
} from "../src/dashboardCard.js";

process.stdout.write(JSON.stringify({
  resources: {
    settings: {
      uri: SETTINGS_CARD_URI,
      html: SETTINGS_CARD_HTML,
      metadata: {
        descriptor: SETTINGS_CARD_RESOURCE_DESCRIPTOR,
        content: SETTINGS_CARD_CONTENT_METADATA
      }
    },
    dashboard: {
      uri: DASHBOARD_CARD_URI,
      html: DASHBOARD_CARD_HTML,
      metadata: {
        descriptor: DASHBOARD_CARD_RESOURCE_DESCRIPTOR,
        content: DASHBOARD_CARD_CONTENT_METADATA
      }
    }
  }
}));
