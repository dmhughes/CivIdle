import type { Building } from "../../shared/definitions/BuildingDefinitions";
import type { Deposit } from "../../shared/definitions/MaterialDefinitions";
import {
   applyBuildingDefaults,
   exploreTile,
   getBottomRightEmptyTile,
} from "../../shared/logic/BuildingLogic";
import { getGameOptions, getGameState, notifyGameStateUpdate } from "../../shared/logic/GameStateLogic";
import { clearIntraTickCache } from "../../shared/logic/IntraTickCache";
import { sortByDistance } from "../../shared/logic/TerrainLogic";
import { makeBuilding, type IBuildingData } from "../../shared/logic/Tile";
import { clearTransportSourceCache, OnBuildingOrUpgradeComplete } from "../../shared/logic/Update";
import { resolveIn } from "../../shared/utilities/Helper";
import { WorldScene } from "./scenes/WorldScene";
import { Singleton } from "./utilities/Singleton";

const TARGET_LEVEL = 10;
const DEPOSIT_MINE_COUNT = 8;

const DEPOSIT_BUILDINGS: ReadonlyArray<{ deposit: Deposit; type: Building }> = [
   { deposit: "Water", type: "Aqueduct" },
   { deposit: "Wood", type: "LoggingCamp" },
   { deposit: "Stone", type: "StoneQuarry" },
];

let initialMinesRun: Promise<void> | undefined;

function findDefaultBuilding(buildingType: Building): IBuildingData | undefined {
   for (const tile of getGameState().tiles.values()) {
      if (tile.building?.type === buildingType) {
         return tile.building;
      }
   }
   return undefined;
}

function setBuildingTargetLevel(building: IBuildingData): void {
   building.desiredLevel = Math.max(building.desiredLevel, TARGET_LEVEL);
   building.status = building.level > 0 ? "upgrading" : "building";
}

function upgradeDefaultBuilding(buildingType: Building): IBuildingData {
   const building = findDefaultBuilding(buildingType);
   if (!building) {
      throw new Error(`No ${buildingType} exists in the current game.`);
   }

   setBuildingTargetLevel(building);
   const gameState = getGameState();
   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return building;
}

function waitForBuildingCompletion(building: IBuildingData): Promise<void> {
   if (building.level >= building.desiredLevel) {
      return Promise.resolve();
   }

   return new Promise((resolve) => {
      const checkCompletion = () => {
         if (building.level >= building.desiredLevel) {
            OnBuildingOrUpgradeComplete.off(checkCompletion);
            resolve();
         }
      };
      OnBuildingOrUpgradeComplete.on(checkCompletion);
      checkCompletion();
   });
}

function createTargetBuilding(buildingType: Building): IBuildingData {
   const building = applyBuildingDefaults(makeBuilding({ type: buildingType }), getGameOptions());
   setBuildingTargetLevel(building);
   return building;
}

function buildNearestDepositMines(): void {
   const gameState = getGameState();
   const bottomRightTile = getBottomRightEmptyTile(gameState);
   if (!bottomRightTile) {
      throw new Error("No empty bottom-right map tile exists in the current game.");
   }

   for (const { deposit, type } of DEPOSIT_BUILDINGS) {
      const deposits = sortByDistance(
         (tile) => Boolean(tile.deposit[deposit]) && !tile.building,
         bottomRightTile[0],
         gameState,
      ).slice(0, DEPOSIT_MINE_COUNT);

      for (const tile of deposits) {
         tile.building = createTargetBuilding(type);
         if (!tile.explored) {
            exploreTile(tile.tile, gameState);
            Singleton().sceneManager.enqueue(WorldScene, (scene) => scene.revealTile(tile.tile));
         }
      }
   }

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
}

async function executeInitialMines(): Promise<void> {
   const stoneQuarry = upgradeDefaultBuilding("StoneQuarry");
   await waitForBuildingCompletion(stoneQuarry);
   await resolveIn(5, null);
   const loggingCamp = upgradeDefaultBuilding("LoggingCamp");
   await waitForBuildingCompletion(loggingCamp);
   await resolveIn(5, null);
   const aqueduct = upgradeDefaultBuilding("Aqueduct");
   await waitForBuildingCompletion(aqueduct);
   buildNearestDepositMines();
}

export function runInitialMines(): Promise<void> {
   if (!initialMinesRun) {
      initialMinesRun = executeInitialMines().finally(() => {
         initialMinesRun = undefined;
      });
   }
   return initialMinesRun;
}
