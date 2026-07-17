import type { ShipOutputs } from "./types/ship-output.js";
import type { ShipInputs } from "./types/ship-input.js";
import { ShipOrchestratorService } from "../../core/services/ship-orchestrator-service.js";
import { ConfigLoaderService } from "../../core/services/config-loader-service.js";

export class ShipCommand {
  private readonly orchestrator: ShipOrchestratorService;
  private readonly configLoader: ConfigLoaderService;

  constructor(
    orchestrator: ShipOrchestratorService,
    configLoader: ConfigLoaderService,
  ) {
    this.orchestrator = orchestrator;
    this.configLoader = configLoader;
  }

  async run(inputs: ShipInputs): Promise<ShipOutputs> {
    const config = this.configLoader.load();
    if (!config.ok) throw config.error;

    const result = await this.orchestrator.execute(inputs.task, config.data);
    if (!result.ok) throw result.error;

    const { receipt, prUrl, prNumber, branch } = result.data;

    return {
      receipt: receipt,
      prUrl,
      prNumber,
      branch,
    };
  }
}
