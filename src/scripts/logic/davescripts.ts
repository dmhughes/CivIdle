import { applyBuildingDefaults, checkBuildingMax, findSpecialBuilding } from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import { getGameOptions, getGameState, notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { makeBuilding } from "../../../shared/logic/Tile";
import { pointToTile, tileToPoint, type Tile } from "../../../shared/utilities/Helper";
import { showToast } from "../ui/GlobalModal";

function inLowerRightQuadrant(x: number, y: number, size: number): boolean {
   const half = Math.ceil(size / 2);
   // lower-right = x >= half && y >= half
   return x >= half && y >= half;
}

function inUpperRightQuadrant(x: number, y: number, size: number): boolean {
   const half = Math.ceil(size / 2);
   // upper-right = x >= half && y < half
   return x >= half && y < half;
}

export function buildMinesInLowerRightQuadrant(): void {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;
   const tiles = Array.from(gs.tiles.keys()) as Tile[];

   const loggingTiles: Tile[] = [];
   const stoneTiles: Tile[] = [];
   const waterTiles: Tile[] = [];

   for (const t of tiles) {
      const p = tileToPoint(t);
      if (!inLowerRightQuadrant(p.x, p.y, size)) continue;
      const tileData = gs.tiles.get(t);
      if (!tileData) continue;
      if (tileData.building) continue; // skip occupied
      const deposits = tileData.deposit;
      if (deposits.Wood) loggingTiles.push(t);
      if (deposits.Stone) stoneTiles.push(t);
      if (deposits.Water) waterTiles.push(t);
   }

   let placedLogging = 0;
   let placedStone = 0;
   let placedWater = 0;

   const options = getGameOptions();

   const takeAndPlace = (list: Tile[], type: any, limit: number, counterRef: (n: number) => void) => {
         for (let i = 0; i < Math.min(limit, list.length); i++) {
            const xy = list[i];
            const b = applyBuildingDefaults(makeBuilding({ type }), options);
            const td = gs.tiles.get(xy);
            if (td) {
               td.building = b;
               counterRef(1);
            }
         }
   };

   // Try lower-right first
   takeAndPlace(loggingTiles, "LoggingCamp", 6, (n) => (placedLogging += n));
   takeAndPlace(stoneTiles, "StoneQuarry", 6, (n) => (placedStone += n));
   takeAndPlace(waterTiles, "Aqueduct", 6, (n) => (placedWater += n));

   // If we didn't place enough of any type, search upper-right quadrant and continue
   if (placedLogging < 6 || placedStone < 6 || placedWater < 6) {
      const loggingUpper: Tile[] = [];
      const stoneUpper: Tile[] = [];
      const waterUpper: Tile[] = [];
      for (const t of tiles) {
         const p = tileToPoint(t);
         if (!inUpperRightQuadrant(p.x, p.y, size)) continue;
         const tileData = gs.tiles.get(t);
         if (!tileData) continue;
         if (tileData.building) continue; // skip occupied
         const deposits = tileData.deposit;
         if (deposits.Wood) loggingUpper.push(t);
         if (deposits.Stone) stoneUpper.push(t);
         if (deposits.Water) waterUpper.push(t);
      }

      if (placedLogging < 6) {
         // skip already placed count
         const needed = 6 - placedLogging;
         takeAndPlace(loggingUpper, "LoggingCamp", needed, (n) => (placedLogging += n));
      }
      if (placedStone < 6) {
         const needed = 6 - placedStone;
         takeAndPlace(stoneUpper, "StoneQuarry", needed, (n) => (placedStone += n));
      }
      if (placedWater < 6) {
         const needed = 6 - placedWater;
         takeAndPlace(waterUpper, "Aqueduct", needed, (n) => (placedWater += n));
      }
   }

   showToast(`Placed ${placedLogging} Logging Camps, ${placedStone} Stone Quarries, ${placedWater} Aqueducts`);

   // --- Extra setup requested: place a 4x4 block immediately to the right of the Headquarter
   try {
      const hqTile = findSpecialBuilding("Headquarter", gs);
      if (hqTile) {
         const hqPoint = tileToPoint(hqTile.tile);
         // place a 4x4 area with its left column immediately to the right of HQ
         const gridSize = 4;
         const startX = hqPoint.x + 1;
         // centre the 4x4 vertically around the HQ
         const startY = hqPoint.y - Math.floor(gridSize / 2);

         let placedWheat = 0;
         let placedHouse = 0;

         const toPlace: Array<{ type: string } > = [];
         // first 4 wheat farms, then 12 houses
         for (let i = 0; i < 4; i++) toPlace.push({ type: "WheatFarm" });
         for (let i = 0; i < 12; i++) toPlace.push({ type: "House" });

         let idx = 0;
         for (let yy = startY; yy < startY + gridSize && idx < toPlace.length; yy++) {
            for (let xx = startX; xx < startX + gridSize && idx < toPlace.length; xx++) {
               // bounds check
               if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
               const pt = { x: xx, y: yy };
               const tile = pointToTile(pt);
               const td = gs.tiles.get(tile);
               if (!td) continue;
               if (td.building) continue; // skip occupied
               const entry = toPlace[idx];
               // respect building max limits
               if (!checkBuildingMax(entry.type as any, gs)) {
                  // skip placing this type if max reached
                  idx++;
                  continue;
               }
               td.building = applyBuildingDefaults(makeBuilding({ type: entry.type as any }), options);
               // ensure explored so it shows up
               td.explored = true;
               if (entry.type === "WheatFarm") placedWheat++;
               else if (entry.type === "House") placedHouse++;
               idx++;
            }
         }
         if (placedWheat || placedHouse) {
            showToast(`Placed ${placedWheat} Wheat Farms and ${placedHouse} Houses in 4x4 beside HQ`);
            notifyGameStateUpdate();
         }
      } else {
         // no HQ found - nothing to do here
      }
   } catch (e) {
      // silently ignore any unexpected errors from placement
      // but surface a toast so the user knows something went wrong
      console.error("Dave script: failed placing 4x4 beside HQ", e);
      showToast("Dave script: failed to auto-place farms/houses (see console)");
   }
}
