/**
 * Sowel Plugin: Displays (MQTT supervision)
 *
 * Generic supervision plugin for any Sowel-supervised display: the
 * `sowel-energy-display` AMOLED firmware is the first implementor;
 * future e-paper / OLED / ePOS displays that publish to the same
 * topic root are auto-discovered with zero plugin change.
 *
 * Subscribes to a configurable MQTT topic root, builds Sowel
 * `Device`s from the retained `state` payload, and dispatches Sowel
 * orders as `cmd/<key>` publishes.  See specs/001-initial-release/
 * for the canonical wire contract.
 */

import { MqttConnector } from "./mqtt-connector.js";
import { DisplaysEngine } from "./displays-engine.js";
import type { DeviceManager, EventBus, Logger } from "./displays-engine.js";

interface SettingsManager {
  get(key: string): string | undefined;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(
    device: Device,
    orderKeyOrDispatchConfig: string | Record<string, unknown>,
    value: unknown,
  ): Promise<void>;
  refresh?(): Promise<void>;
  getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

const INTEGRATION_ID = "displays";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;
const DEFAULT_TOPIC_PREFIX = "sowel-display";

class DisplaysPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Sowel Displays";
  readonly description = "MQTT supervision for Sowel-supervised displays";
  readonly icon = "Monitor";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private mqtt: MqttConnector | null = null;
  private engine: DisplaysEngine | null = null;
  private status: IntegrationStatus = "disconnected";

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.mqtt && !this.mqtt.isConnected()) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return this.getSetting("mqtt_url") !== undefined;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      {
        key: "mqtt_url",
        label: "MQTT Broker URL",
        type: "text",
        required: true,
        placeholder: "mqtt://localhost:1883",
      },
      { key: "mqtt_username", label: "MQTT Username", type: "text", required: false },
      { key: "mqtt_password", label: "MQTT Password", type: "password", required: false },
      {
        key: "mqtt_client_id",
        label: "MQTT Client ID",
        type: "text",
        required: false,
        defaultValue: "sowel-displays",
      },
      {
        key: "topic_prefix",
        label: "Topic prefix",
        type: "text",
        required: false,
        defaultValue: DEFAULT_TOPIC_PREFIX,
      },
    ];
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) {
      this.status = "not_configured";
      return;
    }

    const mqttUrl = this.getSetting("mqtt_url")!;
    const mqttUsername = this.getSetting("mqtt_username") || undefined;
    const mqttPassword = this.getSetting("mqtt_password") || undefined;
    const baseClientId = this.getSetting("mqtt_client_id") ?? "sowel-displays";
    const mqttClientId = `${baseClientId}-${Math.random().toString(36).slice(2, 8)}`;
    const topicPrefix =
      this.getSetting("topic_prefix")?.trim() || DEFAULT_TOPIC_PREFIX;

    try {
      const connector = new MqttConnector(
        mqttUrl,
        { username: mqttUsername, password: mqttPassword, clientId: mqttClientId },
        this.eventBus,
        this.logger,
        INTEGRATION_ID,
        // Keep `this.status` in sync with the real socket for the whole
        // lifetime of the plugin, not just the snapshot taken below: a broker
        // unreachable at boot connects for real seconds later, and the old
        // one-shot read froze the plugin on "disconnected" forever
        // (mchacher/sowel-plugin-zigbee2mqtt#19).
        (connected) => {
          // Ignore a connector this plugin no longer owns (a stop/start cycle
          // leaves the old client emitting for a while), and never resurrect a
          // start() that failed.
          if (this.mqtt !== connector || this.status === "error") return;
          this.status = connected ? "connected" : "disconnected";
        },
      );
      this.mqtt = connector;
      await this.mqtt.connect();

      this.engine = new DisplaysEngine(
        INTEGRATION_ID,
        topicPrefix,
        this.mqtt,
        this.deviceManager,
        this.logger,
      );
      this.engine.start();

      // Best-effort snapshot for the log line below: the callback above is the
      // source of truth from here on and corrects it once the broker answers.
      this.status = this.mqtt.isConnected() ? "connected" : "disconnected";
      this.logger.info(
        { topicPrefix } as Record<string, unknown>,
        "Sowel Displays plugin started",
      );
    } catch (err) {
      this.status = "error";
      this.logger.error(
        { err } as Record<string, unknown>,
        "Failed to start Sowel Displays plugin",
      );
    }
  }

  async stop(): Promise<void> {
    if (this.mqtt) {
      await this.mqtt.disconnect();
      this.mqtt = null;
      this.engine = null;
      this.status = "disconnected";
      this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
      this.logger.info({} as Record<string, unknown>, "Sowel Displays plugin stopped");
    }
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    if (!this.engine || !this.mqtt?.isConnected()) {
      throw new Error("Sowel Displays plugin not connected");
    }
    this.engine.executeOrder(device, orderKey, value);
  }

  private getSetting(key: string): string | undefined {
    return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`);
  }
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new DisplaysPlugin(deps);
}
