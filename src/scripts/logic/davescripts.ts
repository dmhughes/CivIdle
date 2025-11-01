import type { Building } from "../../../shared/definitions/BuildingDefinitions";
import {
   applyBuildingDefaults,
   checkBuildingMax,
   findSpecialBuilding
} from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import type { GameState } from "../../../shared/logic/GameState";
import { getGameOptions, getGameState, notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { makeBuilding, type ITileData } from "../../../shared/logic/Tile";
import { pointToTile, tileToPoint, type Tile } from "../../../shared/utilities/Helper";
import { WorldScene } from "../scenes/WorldScene";
import { showToast } from "../ui/GlobalModal";
import { Singleton } from "../utilities/Singleton";

// Find the nearest empty tile (no building) to a centre point within maxRadius.
function findNearestEmptyTile(
   center: { x: number; y: number },
   maxRadius: number,
   size: number,
   gs: GameState,
): Tile | null {
   for (let r = 0; r <= maxRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
         const dy = r - Math.abs(dx);
         const candidates: { x: number; y: number }[] = [];
         candidates.push({ x: center.x + dx, y: center.y + dy });
         if (dy !== 0) candidates.push({ x: center.x + dx, y: center.y - dy });
         for (const pt of candidates) {
            if (pt.x < 0 || pt.y < 0 || pt.x >= size || pt.y >= size) continue;
            const t = pointToTile(pt);
            const td = gs.tiles.get(t);
            if (!td) continue;
            if (!td.building) return t;
         }
      }
   }
   return null;
}

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
   const tiles = Array.from(gs.tiles.entries()) as [Tile, ITileData][];

   // Sort all tiles by distance to bottom-right corner (size-1,size-1)
   const corner = { x: size - 1, y: size - 1 };
   const sorted = tiles.sort((a, b) => {
      const pa = tileToPoint(a[0]);
      const pb = tileToPoint(b[0]);
      const da = Math.hypot(corner.x - pa.x, corner.y - pa.y);
      const db = Math.hypot(corner.x - pb.x, corner.y - pb.y);
      return da - db;
   });

   // Count existing buildings first
   let placedLogging = 0;
   let placedStone = 0;
   let placedWater = 0;
   for (const td of gs.tiles.values()) {
      if (!td.building) continue;
      if (td.building.type === "LoggingCamp") placedLogging++;
      else if (td.building.type === "StoneQuarry") placedStone++;
      else if (td.building.type === "Aqueduct") placedWater++;
   }

   const options = getGameOptions();
   // We want final total of 7 of each (1 initial + 6 added). Compute needed per-type below.

   const placeBuildingAt = (xy: Tile, type: Building, desiredLevel = 16): boolean => {
      const td = gs.tiles.get(xy);
      if (!td) return false;
      // Respect global max
      if (!checkBuildingMax(type, gs)) return false;
      const created = applyBuildingDefaults(makeBuilding({ type }), options);
      created.level = 1;
      created.desiredLevel = desiredLevel;
      created.status = "building";
      td.building = created;
      td.explored = true;
      return true;
   };

   const tryPlaceForType = (
      resourceKey: keyof typeof Config.Resource | null,
      type: Building,
      target: number,
      counter: (n: number) => void,
   ) => {
      let placed = 0;
      if (target <= 0) {
         counter(0);
         return;
      }
      // Pass 1: empty tiles with deposit
      for (const [xy, td] of sorted) {
         if (placed >= target) break;
         if (td.building) continue;
         if (resourceKey && !(td.deposit as Record<string, unknown>)[resourceKey as string]) continue;
         if (placeBuildingAt(xy, type)) placed++;
      }
      // Pass 3: empty tiles without deposit
      for (const [xy, td] of sorted) {
         if (placed >= target) break;
         if (td.building) continue;
         if (placeBuildingAt(xy, type)) placed++;
      }
      // NOTE: we do NOT perform replacement passes here to avoid overwriting
      // existing buildings. This preserves the "never overwrite" rule.
      counter(placed);
   };

   // LoggingCamp uses Wood, StoneQuarry uses Stone, Aqueduct uses Water
   // Compute how many more are needed to reach a total of 7
   const needLogging = Math.max(0, 7 - placedLogging);
   const needStone = Math.max(0, 7 - placedStone);
   const needWater = Math.max(0, 7 - placedWater);

   tryPlaceForType("Wood", "LoggingCamp", needLogging, (n) => {
      placedLogging += n;
   });
   tryPlaceForType("Stone", "StoneQuarry", needStone, (n) => {
      placedStone += n;
   });
   tryPlaceForType("Water", "Aqueduct", needWater, (n) => {
      placedWater += n;
   });

   showToast(
      `Placed ${placedLogging} Logging Camps, ${placedStone} Stone Quarries, ${placedWater} Aqueducts`,
   );
   // Notify the UI/game state that tiles changed so construction can proceed
   notifyGameStateUpdate();

   // Force an immediate refresh of the world scene visuals so new/removed buildings
   // appear without requiring an application restart.
   try {
      const scene = Singleton().sceneManager.getCurrent(WorldScene);
      if (scene) scene.onGameStateChanged(getGameState());
   } catch (err) {
      // ignore any errors (e.g., if singletons not initialized)
   }

   // --- Extra setup requested: place a 4x4 block immediately to the right of the Headquarter
   try {
      const hqTile = findSpecialBuilding("Headquarter", gs);
      if (hqTile) {
         const hqPoint = tileToPoint(hqTile.tile);
         showToast(`Headquarter located at ${hqPoint.x},${hqPoint.y}`);
         console.log("Dave script: Headquarter at", hqPoint);

         // If Statistics (Statistics Office) already exists anywhere, report and skip trying to place another
         try {
            const existingStats = findSpecialBuilding("Statistics", gs);
            if (existingStats) {
               const ep = tileToPoint(existingStats.tile);
               showToast(`Statistics Office already present at ${ep.x},${ep.y}`);
            }
         } catch (err) {
            // ignore
         }

         // --- Place Statistics Office immediately to the left of the HQ if possible
         try {
            const leftPt = { x: hqPoint.x - 1, y: hqPoint.y };
            if (leftPt.x < 0 || leftPt.y < 0 || leftPt.x >= size || leftPt.y >= size) {
               showToast("Skipped Statistics Office: left tile is out of bounds");
            } else {
               const leftTile = pointToTile(leftPt);
               const leftTd = gs.tiles.get(leftTile);
               if (!leftTd) {
                  showToast("Skipped Statistics Office: left tile not found in game state");
               } else if (leftTd.building) {
                  showToast(`Skipped Statistics Office: left tile occupied by ${leftTd.building.type}`);
               } else if (!checkBuildingMax("Statistics" as Building, gs)) {
                  showToast("Skipped Statistics Office: maximum already built");
               } else {
                  const stats = applyBuildingDefaults(
                     makeBuilding({ type: "Statistics" as Building }),
                     options,
                  );
                  // Build normally to level 1: start at level 0 (construction) and request desiredLevel 1
                  stats.level = 0;
                  stats.desiredLevel = 1;
                  stats.status = "building";
                  leftTd.building = stats;
                  leftTd.explored = true;
                  showToast("Placed Statistics Office to the left of the Headquarter");
                  notifyGameStateUpdate();
               }
            }
         } catch (err) {
            console.error("Dave script: failed placing Statistics Office", err);
            showToast("Dave script: failed placing Statistics Office (see console)");
         }

         // place a 4x4 area with its left column immediately to the right of HQ
         const gridSize = 4;
         const startX = hqPoint.x + 1;
         // centre the 4x4 vertically around the HQ
         const startY = hqPoint.y - Math.floor(gridSize / 2);

         let placedWheat = 0;
         let placedHouse = 0;

         const toPlace: Array<{ type: string }> = [];
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
               const entry = toPlace[idx];
               if (td.building) {
                  // If it's the same type, request an upgrade to level 15 and count it as satisfied
                  if (td.building.type === entry.type) {
                     if ((td.building.desiredLevel ?? td.building.level) < 15) {
                        td.building.desiredLevel = 15;
                     }
                     if (entry.type === "WheatFarm") placedWheat++;
                     else if (entry.type === "House") placedHouse++;
                     idx++;
                     continue;
                  }
                  continue; // otherwise skip occupied
               }
               // respect building max limits
               if (!checkBuildingMax(entry.type as Building, gs)) {
                  // skip placing this type if max reached
                  idx++;
                  continue;
               }
               // create building and set desired level after defaults so it's not immediately completed
               const created = applyBuildingDefaults(makeBuilding({ type: entry.type as Building }), options);
               created.level = 1;
               // Houses and WheatFarms should target level 15 per user
               if (entry.type === "WheatFarm" || entry.type === "House") {
                  created.desiredLevel = 15;
               } else {
                  created.desiredLevel = 16;
               }
               created.status = "building";
               td.building = created;
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
         showToast("Headquarter not found - cannot place Statistics Office or 4x4 block");
         console.warn("Dave script: findSpecialBuilding('Headquarter') returned null");
      }
   } catch (e) {
      // silently ignore any unexpected errors from placement
      // but surface a toast so the user knows something went wrong
      console.error("Dave script: failed placing 4x4 beside HQ", e);
      showToast("Dave script: failed to auto-place farms/houses (see console)");
   }
}

export async function buildApartmentsSupportBuildings(): Promise<void> {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const options = getGameOptions();
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   // Top-right strip: 10 tiles wide from right edge inward, along the top rows
   // Use 10-wide strip: columns [size-10 .. size-1]
   const startX = Math.max(0, size - 10);
   // Desired counts for the support area (excluding infrastructure)
   const supportPlan: Array<{ type: Building; count: number }> = [
      { type: "Bakery" as Building, count: 8 },
      { type: "PoultryFarm" as Building, count: 15 },
      { type: "CheeseMaker" as Building, count: 12 },
      { type: "FlourMill" as Building, count: 2 },
      { type: "DairyFarm" as Building, count: 2 },
   ];

   // Place or upgrade buildings to required level (16) using the named-args wrapper.
   const requiredTopLevel = 16;
   const stripWidth = Math.max(1, size - startX);

   const withTarget = (arr: Array<{ type: Building; count: number }>, target: number) =>
      arr.map((p) => ({ type: p.type, count: p.count, targetLevel: target }));

   // User requested support buildings to start at row index 4 (row 5). Use a sensible
   // fallback: if the map is smaller, start at the last available row.
   const desiredSupportStart = 4;
   const placedSupport = supportPlan.length > 0
      ? buildStripPlanNamed({
         stripXStart: startX,
         width: stripWidth,
         rowStart: Math.min(desiredSupportStart, size - 1),
         rowEnd: size - 1,
         plan: withTarget(supportPlan, requiredTopLevel),
         opts: { preserveDeposits: false, upgradeExisting: true },
      })
      : ({} as Record<string, number>);

   const topSummary: string[] = [];
   for (const p of supportPlan) {
      const n = placedSupport[p.type] || 0;
      topSummary.push(`${n} ${p.type}`);
   }

   showToast(`Support buildings setup: ${topSummary.join(", ")}`);
}

export async function buildApartmentsInfrastructureBuildings(): Promise<void> {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;
   const startX = Math.max(0, size - 10);
   const stripWidth = Math.max(1, size - startX);

   const infraPlan: Array<{ type: Building; count: number }> = [
      { type: "Brickworks" as Building, count: 4 },
      { type: "LumberMill" as Building, count: 4 },
   ];

   const requiredTopLevel = 16;
   const withTarget = (arr: Array<{ type: Building; count: number }>, target: number) =>
      arr.map((p) => ({ type: p.type, count: p.count, targetLevel: target }));

   // Place infrastructure on row 0 only (top row)
   const placedInfra = (size > 0)
      ? buildStripPlanNamed({
         stripXStart: startX,
         width: stripWidth,
         rowStart: 0,
         rowEnd: 0,
         plan: withTarget(infraPlan, requiredTopLevel),
         opts: { preserveDeposits: false, upgradeExisting: true },
      })
      : ({} as Record<string, number>);

   const infraSummary: string[] = [];
   for (const p of infraPlan) {
      const n = placedInfra[p.type] || 0;
      infraSummary.push(`${n} ${p.type}`);
   }
   showToast(`Infrastructure setup: ${infraSummary.join(", ")}`);
}

export async function buildApartmentsPlaceApartments(): Promise<void> {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const options = getGameOptions();
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   // Apartments: place in batches until total of 750 apartments (user requested)
   const desiredTotal = 750;
   // Count existing apartments and request upgrades to level 10
   let existingApartments = 0;
   for (const [, tileData] of gs.tiles) {
      if (tileData.building && tileData.building.type === ("Apartment" as Building)) {
         existingApartments++;
         if ((tileData.building.desiredLevel ?? tileData.building.level) < 10) {
            tileData.building.desiredLevel = 10;
         }
      }
   }

   let totalNow = existingApartments;
   if (totalNow >= desiredTotal) {
      showToast(`Already have ${totalNow} Apartments (upgraded where necessary)`);
      notifyGameStateUpdate();
      return;
   }

   const batchSize = 100;
   // Helper: sleep until next tick
   const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

   // Generator of candidate tiles in column-major order starting at x=0,y=0
   const candidates: Tile[] = [];
   for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
         candidates.push(pointToTile({ x, y }));
      }
   }

   let candIndex = 0;
   outerBatches: while (totalNow < desiredTotal) {
      const need = Math.min(batchSize, desiredTotal - totalNow);
      const placedThisBatch: Tile[] = [];

      // Place up to 'need' apartments following candidate order
      while (placedThisBatch.length < need && candIndex < candidates.length) {
         const xy = candidates[candIndex++];
         const td = gs.tiles.get(xy);
         if (!td) continue;
         if (td.building) continue;
         try {
            if (!checkBuildingMax("Apartment" as Building, gs)) {
               // Global limit reached, stop all placement
               break outerBatches;
            }
         } catch (e) {
            // ignore and try
         }
         try {
            const created = applyBuildingDefaults(makeBuilding({ type: "Apartment" as Building }), options);
            created.level = 0;
            created.desiredLevel = 10;
            created.status = "building";
            td.building = created;
            td.explored = true;
            placedThisBatch.push(xy);
         } catch (err) {
            // ignore failures
         }
      }

      if (placedThisBatch.length === 0) {
         // No space in map to place further apartments
         showToast(`Could only place ${totalNow}/${desiredTotal} Apartments (map full)`);
         break;
      }

      totalNow += placedThisBatch.length;
      showToast(`Placed ${placedThisBatch.length} Apartments (batch). Waiting for completion...`);
      notifyGameStateUpdate();

      // Wait for the batch to complete: poll until all tiles in placedThisBatch are completed
      let attempts = 0;
      while (true) {
         let allDone = true;
         for (const xy of placedThisBatch) {
            const td = gs.tiles.get(xy);
            if (!td || !td.building) continue;
            const b = td.building;
            if (b.status === "building") {
               allDone = false;
               break;
            }
            if ((b.desiredLevel ?? b.level) > (b.level ?? 0) && b.status !== "completed") {
               allDone = false;
               break;
            }
         }
         if (allDone) break;
         // avoid tight loop; wait 1s then recheck
         await sleep(1000);
         attempts++;
         // safety: after many attempts, give up and continue to next batch to avoid infinite loop
         if (attempts > 300) break; // ~5 minutes
      }

      showToast(`Batch completed: ${placedThisBatch.length} Apartments`);
      notifyGameStateUpdate();
   }

   showToast(`Apartment placement finished: ${totalNow}/${desiredTotal}`);
}

export async function buildApartmentsStripAndLeftColumn(): Promise<void> {
   // Run infrastructure (top-row) first, then support buildings, then place apartments
   await buildApartmentsInfrastructureBuildings();
   await buildApartmentsSupportBuildings();
   await buildApartmentsPlaceApartments();
}

export function buildBigBenMaterials(): void {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const options = getGameOptions();
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   const stripXStart = Math.max(0, size - 10);

   // Precise inventory requested by user
   const plan: Array<{ type: Building; count: number }> = [
      { type: "CottonPlantation" as Building, count: 4 },
      { type: "CottonMill" as Building, count: 8 },
      { type: "IronForge" as Building, count: 24 },
      { type: "Marbleworks" as Building, count: 4 },
      { type: "PaperMaker" as Building, count: 4 },
      { type: "Stable" as Building, count: 4 },
      { type: "Brewery" as Building, count: 4 },
      { type: "PoetrySchool" as Building, count: 4 },
      { type: "SwordForge" as Building, count: 4 },
      { type: "Armory" as Building, count: 4 },
      { type: "PaintersGuild" as Building, count: 8 },
      { type: "FurnitureWorkshop" as Building, count: 4 },
      { type: "Shrine" as Building, count: 16 },
      { type: "MusiciansGuild" as Building, count: 4 },
      { type: "KnightCamp" as Building, count: 4 },
      { type: "University" as Building, count: 8 },
      { type: "Museum" as Building, count: 8 },
      { type: "Courthouse" as Building, count: 8 },
      { type: "Parliament" as Building, count: 16 },
   ];

   // Sort plan entries by ascending building tier (deterministic)
   const getTier = (b: Building) => {
      try {
         // Config.BuildingTier maps names to numbers; fallback to large number
         return (Config.BuildingTier as Record<string, number>)[b] ?? 9999;
      } catch (e) {
         return 9999;
      }
   };

   const sortedPlan = plan.slice().sort((a, b) => getTier(a.type) - getTier(b.type));

   const targetLevel = 15;
   // Initialize placedCounts for reporting
   const placedCounts: Record<string, number> = {};
   for (const p of sortedPlan) placedCounts[p.type] = 0;

   // Use the reusable strip placer starting at row index 12 (row 13).
   const stripWidth = Math.max(1, size - stripXStart);
   const planWithTarget = sortedPlan.map((p) => ({ type: p.type, count: p.count, targetLevel }));

   const placedFromStrip = buildStripPlanNamed({
      stripXStart,
      width: stripWidth,
      rowStart: Math.min(12, Math.max(0, size - 1)), // start at index 12 (row 13), clamp to map
      rowEnd: size - 1,
      plan: planWithTarget,
      opts: { preserveDeposits: false, upgradeExisting: true },
   });

   // Merge results
   for (const k of Object.keys(placedFromStrip)) placedCounts[k] = (placedCounts[k] || 0) + (placedFromStrip[k] || 0);

   // Fallback: if any entries are still short, scan whole map and upgrade existing buildings to count them
   for (const entry of sortedPlan) {
      let remaining = Math.max(0, entry.count - (placedCounts[entry.type] || 0));
      if (remaining <= 0) continue;
      for (const [, tileData] of gs.tiles) {
         if (remaining <= 0) break;
         if (tileData.building && tileData.building.type === entry.type) {
            if ((tileData.building.desiredLevel ?? tileData.building.level) < targetLevel) {
               tileData.building.desiredLevel = targetLevel;
            }
            placedCounts[entry.type] = (placedCounts[entry.type] || 0) + 1;
            remaining--;
         }
      }
   }

   const summary: string[] = [];
   for (const p of sortedPlan) {
      const n = placedCounts[p.type] || 0;
      summary.push(`${n} ${p.type}`);
   }

      // --- Ensure Iron and Copper mines: 2x IronMiningCamp and 2x CopperMiningCamp total
      // Count existing mines and upgrade them to target level if needed
      let existingIron = 0;
      let existingCopper = 0;
      for (const [, td] of gs.tiles) {
         if (!td?.building) continue;
         if (td.building.type === "IronMiningCamp") {
            existingIron++;
            if ((td.building.desiredLevel ?? td.building.level) < targetLevel) td.building.desiredLevel = targetLevel;
         } else if (td.building.type === "CopperMiningCamp") {
            existingCopper++;
            if ((td.building.desiredLevel ?? td.building.level) < targetLevel) td.building.desiredLevel = targetLevel;
         }
      }

      const needIron = Math.max(0, 2 - existingIron);
      const needCopper = Math.max(0, 2 - existingCopper);

      if (needIron > 0 || needCopper > 0) {
         // collect empty deposit tiles for each resource
         const ironTiles: Tile[] = [];
         const copperTiles: Tile[] = [];
         for (const t of Array.from(gs.tiles.keys()) as Tile[]) {
            const td = gs.tiles.get(t);
            if (!td) continue;
            if (td.building) continue; // only on empty tiles
            const d = td.deposit;
            if (d?.Iron) ironTiles.push(t);
            if (d?.Copper) copperTiles.push(t);
         }

         const corner = { x: size - 1, y: size - 1 };
         const dist = (tile: Tile) => {
            const p = tileToPoint(tile);
            return Math.hypot(corner.x - p.x, corner.y - p.y);
         };
         ironTiles.sort((a, b) => dist(a) - dist(b));
         copperTiles.sort((a, b) => dist(a) - dist(b));

         let placedIron = 0;
         let placedCopper = 0;

         // Place iron mines
         for (let i = 0; i < ironTiles.length && placedIron < needIron; i++) {
            const tile = ironTiles[i];
            const td = gs.tiles.get(tile);
            if (!td) continue;
            try {
               if (!checkBuildingMax("IronMiningCamp" as Building, gs)) break;
            } catch (e) {
               // ignore
            }
            try {
               const b = applyBuildingDefaults(makeBuilding({ type: "IronMiningCamp" as Building }), options);
               b.level = 0;
               b.desiredLevel = targetLevel;
               b.status = "building";
               td.building = b;
               td.explored = true;
               placedIron++;
            } catch (err) {
               // ignore
            }
         }

         // Place copper mines
         for (let i = 0; i < copperTiles.length && placedCopper < needCopper; i++) {
            const tile = copperTiles[i];
            const td = gs.tiles.get(tile);
            if (!td) continue;
            try {
               if (!checkBuildingMax("CopperMiningCamp" as Building, gs)) break;
            } catch (e) {
               // ignore
            }
            try {
               const b = applyBuildingDefaults(makeBuilding({ type: "CopperMiningCamp" as Building }), options);
               b.level = 0;
               b.desiredLevel = targetLevel;
               b.status = "building";
               td.building = b;
               td.explored = true;
               placedCopper++;
            } catch (err) {
               // ignore
            }
         }

         existingIron += placedIron;
         existingCopper += placedCopper;
         // report if we couldn't reach the required counts
         if (existingIron < 2 || existingCopper < 2) {
            showToast(`Warning: Mines requirement not fully satisfied: Iron ${existingIron}/2, Copper ${existingCopper}/2`);
         } else {
            showToast(`Mines placed/upgraded: Iron ${existingIron}/2, Copper ${existingCopper}/2`);
         }
      } else {
         showToast(`Mines already satisfied: Iron ${existingIron}/2, Copper ${existingCopper}/2`);
      }

   showToast(`Build Big Ben Materials started in right strip: ${summary.join(", ")}`);
      notifyGameStateUpdate();
      try {
         const scene = Singleton().sceneManager.getCurrent(WorldScene);
         if (scene) scene.onGameStateChanged(getGameState());
      } catch (err) {
         // ignore visual refresh errors
      }
}

export function prepareCondoMaterials(): void {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const options = getGameOptions();
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   // Rightmost 10-column strip (columns [size-10 .. size-1])
   const stripStartX = Math.max(0, size - 10);

   // Building plan: non-pizzeria items first, Pizzeria handled specially later
   const plan: Array<{ type: Building; count: number }> = [
      { type: "Sandpit" as Building, count: 1 },
      { type: "SteelMill" as Building, count: 4 },
      { type: "RebarPlant" as Building, count: 5 },
      { type: "ConcretePlant" as Building, count: 5 },
      { type: "ReinforcedConcretePlant" as Building, count: 14 },
      // Pizzerias intentionally omitted here; we'll place them after a gap
      { type: "IronForge" as Building, count: 5 },
   ];

   const requiredLevel = 16;
   const placedCounts: Record<string, number> = {};
   for (const p of plan) placedCounts[p.type] = 0;
   placedCounts.Pizzeria = 0;

   // --- Demolition phase (new): scan the rightmost 10-column strip starting at row 9
   // Keep any wonders (special) and keep any tile that already contains a matching
   // deposit-extracting building (e.g., IronMiningCamp on an Iron deposit). Delete
   // other buildings. Scan row-by-row starting at row index 8; when an empty tile
   // is encountered during the scan, stop the demolition phase entirely.
   const demolitionStartRow = 8; // 0-based row 8 == 9th row
   let demolishedCount = 0;
   let stopDemolition = false;
   for (let y = demolitionStartRow; y < size && !stopDemolition; y++) {
      for (let x = stripStartX; x < size; x++) {
         const tile = pointToTile({ x, y });
         const td = gs.tiles.get(tile);
         if (!td) continue;
         // If tile is empty, stop the entire demolition phase (user requested)
         if (!td.building) {
            stopDemolition = true;
            break;
         }

         const bt = td.building.type;
         const def = Config.Building[bt];

             // Leave wonders/natural wonders alone
             if (def && def.special != null) {
            continue;
         }

         // If tile has a deposit and the existing building extracts from that deposit,
         // keep it (it's a mine producing resources)
         if (td.deposit && def && def.deposit) {
            // check if any deposit keys overlap
            let match = false;
            for (const k of Object.keys(def.deposit)) {
               if ((td.deposit as Record<string, unknown>)[k]) {
                  match = true;
                  break;
               }
            }
            if (match) continue;
         }

         // Otherwise delete the building in this strip tile
         td.building = undefined;
         demolishedCount++;
      }
   }

   if (demolishedCount > 0) {
      showToast(`Demolished ${demolishedCount} non-mine/non-wonder building(s) in right strip before building phase`);
      try {
         notifyGameStateUpdate();
         const scene = Singleton().sceneManager.getCurrent(WorldScene);
         if (scene) scene.onGameStateChanged(getGameState());
      } catch (err) {
         // ignore visual refresh errors
      }
   }

   // Rules: skip the first 8 rows (0-based index 8 == 9th row), then fill
   // non-pizzeria plan into the strip row-by-row, left->right, wrapping down.
   const skipTopRows = 8; // User requested to start at row 9 (0-based index 8)
   const pizzeriaGapRows = 3;
   const pizzeriaCount = 50;

   let planIndex = 0;
   let placedForCurrent = 0;

   // Start placing at row = skipTopRows
   // Deterministic placement: do NOT overwrite tiles. Skip occupied tiles
   // unless the existing building is the same type, in which case request an
   // upgrade and count it toward the plan.
   for (let y = skipTopRows; y < size && planIndex < plan.length; y++) {
      for (let x = stripStartX; x < size && planIndex < plan.length; x++) {
         const tile = pointToTile({ x, y });
         const td = gs.tiles.get(tile);
         if (!td) continue;

         const current = plan[planIndex];
         // If tile already occupied, only take it if it's the same type (upgrade)
         if (td.building) {
            if (td.building.type === current.type) {
               if ((td.building.desiredLevel ?? td.building.level) < requiredLevel) {
                  td.building.desiredLevel = requiredLevel;
               }
               placedForCurrent++;
               placedCounts[current.type] = (placedCounts[current.type] || 0) + 1;
            }
            // otherwise skip occupied tile
            if (placedForCurrent >= current.count) {
               planIndex++;
               placedForCurrent = 0;
            }
            continue;
         }

         try {
            if (!checkBuildingMax(current.type, gs)) {
               // Can't place more of this type due to global limits — skip to next type
               planIndex++;
               placedForCurrent = 0;
               continue;
            }
         } catch (e) {
            // If checkBuildingMax fails for any reason, proceed but try to place
         }

         try {
            // Place only on empty tiles (do not overwrite)
            const created = applyBuildingDefaults(makeBuilding({ type: current.type }), options);
            created.level = 1;
            created.desiredLevel = requiredLevel;
            created.status = "building";
            td.building = created;
            td.explored = true;
            placedForCurrent++;
            placedCounts[current.type] = (placedCounts[current.type] || 0) + 1;
         } catch (err) {
            // ignore placement failure and continue
         }

         if (placedForCurrent >= current.count) {
            planIndex++;
            placedForCurrent = 0;
         }
      }
   }

   // After placing non-pizzeria items, place Pizzerias deterministically starting at row 15 (0-based 14)
   let pPlaced = 0;
   // Start Pizzerias at 0-based row 14 (the 15th row). Clamp to map.
   const requestedPizzeriaStart = 14;
   const pStartY = Math.min(size - 1, requestedPizzeriaStart);

   // Place pizzerias starting at pStartY left->right across the strip (deterministic)
   const stripWidth = Math.max(1, size - stripStartX);
   for (let y = pStartY; y < size && pPlaced < pizzeriaCount; y++) {
      for (let x = stripStartX; x < size && pPlaced < pizzeriaCount; x++) {
         const td = gs.tiles.get(pointToTile({ x, y }));
         if (!td) continue;

         // If occupied, only accept if it's already a Pizzeria: upgrade & count it.
         if (td.building) {
            if (td.building.type === "Pizzeria") {
               if ((td.building.desiredLevel ?? td.building.level) < requiredLevel) {
                  td.building.desiredLevel = requiredLevel;
               }
               pPlaced++;
               placedCounts.Pizzeria = (placedCounts.Pizzeria || 0) + 1;
            }
            continue; // don't overwrite
         }

         try {
            if (!checkBuildingMax("Pizzeria" as Building, gs)) {
               // global limit reached
               y = size; // force outer loop exit
               break;
            }
         } catch (e) {
            // ignore
         }
         try {
            // Place only on empty tile
            const created = applyBuildingDefaults(makeBuilding({ type: "Pizzeria" as Building }), options);
            created.level = 1;
            created.desiredLevel = requiredLevel;
            created.status = "building";
            td.building = created;
            td.explored = true;
            pPlaced++;
            placedCounts.Pizzeria = (placedCounts.Pizzeria || 0) + 1;
         } catch (err) {
            // ignore
         }
      }
   }

   // Compute last pizza row and start support buildings on the row directly after the pizza block
   let postYStart: number;
   if (pPlaced > 0) {
      const rowsUsed = Math.ceil(pPlaced / stripWidth);
      const lastPizzaRow = pStartY + rowsUsed - 1;
      postYStart = Math.min(size - 1, lastPizzaRow + 1);
   } else {
      postYStart = Math.min(size - 1, pStartY + 1);
   }

      // Immediately after pizzas, place supporting farms/factories so pizzas can be produced.
      // Exact support set and order requested by user: FlourMill, PoultryFarm, CheeseMaker, DairyFarm (5 of each)
      const postPlan: Array<{ type: Building; count: number }> = [
         { type: "FlourMill" as Building, count: 5 },
         { type: "PoultryFarm" as Building, count: 5 },
         { type: "CheeseMaker" as Building, count: 5 },
         { type: "DairyFarm" as Building, count: 5 },
      ];

      // Start searching directly below the last pizza row (approx pStartY + rows used), but if pizzas exhausted map, just scan from pStartY downward
      const postPlacedCounts: Record<string, number> = {};
      for (const p of postPlan) postPlacedCounts[p.type] = 0;

   // Place each postPlan entry sequentially into the strip left->right, wrapping rows
      for (const entry of postPlan) {
         let remaining = entry.count;
         for (let y = postYStart; y < size && remaining > 0; y++) {
         for (let x = stripStartX; x < size && remaining > 0; x++) {
            const td = gs.tiles.get(pointToTile({ x, y }));
            if (!td) continue;
            // Respect existing buildings in the strip: do not overwrite. Place
            // support buildings in addition to anything already present, scanning
            // downward until counts are satisfied or map end.
            if (td.building) continue;
            try {
               const created = applyBuildingDefaults(makeBuilding({ type: entry.type }), options);
               created.level = 1;
               created.desiredLevel = requiredLevel;
               created.status = "building";
               td.building = created;
               td.explored = true;
               remaining--;
               postPlacedCounts[entry.type] = (postPlacedCounts[entry.type] || 0) + 1;
            } catch (err) {
               // ignore placement failures and continue
            }
         }
         }
         // advance start row for next type so they don't all try to place on same rows
         postYStart += 0; // keep continuous placement; adjust if you want separation
      }

      // Merge postPlacedCounts into placedCounts for reporting
      for (const k of Object.keys(postPlacedCounts)) {
         placedCounts[k] = (placedCounts[k] || 0) + (postPlacedCounts[k] || 0);
      }

   const summary: string[] = [];
   for (const p of plan) {
      const n = placedCounts[p.type] || 0;
      summary.push(`${n} ${p.type}`);
   }

   // --- Search entire map for Coal / Iron / Copper deposit tiles and try to place up to 2 mines each
   const coalTiles: Tile[] = [];
   const ironTiles: Tile[] = [];
   const copperTiles: Tile[] = [];

   for (const t of Array.from(gs.tiles.keys()) as Tile[]) {
      const td = gs.tiles.get(t);
      if (!td) continue;
      if (td.building) continue; // only on empty tiles
      const d = td.deposit;
      if (d.Coal) coalTiles.push(t);
      if (d.Iron) ironTiles.push(t);
      if (d.Copper) copperTiles.push(t);
   }

   // Sort deposit tile lists by distance to bottom-right so mines are placed
   // as close to the bottom-right corner as possible (deterministic).
   const corner = { x: size - 1, y: size - 1 };
   const sortByCorner = (a: Tile, b: Tile) => {
      const pa = tileToPoint(a);
      const pb = tileToPoint(b);
      const da = Math.hypot(corner.x - pa.x, corner.y - pa.y);
      const db = Math.hypot(corner.x - pb.x, corner.y - pb.y);
      return da - db;
   };
   coalTiles.sort(sortByCorner);
   ironTiles.sort(sortByCorner);
   copperTiles.sort(sortByCorner);

   const placeMines = (list: Tile[], type: Building, limit: number) => {
      let placed = 0;
      for (let i = 0; i < list.length && placed < limit; i++) {
         const tile = list[i];
         const td = gs.tiles.get(tile);
         if (!td) continue;
         if (td.building) continue;
         try {
            if (!checkBuildingMax(type, gs)) break;
         } catch (e) {
            // ignore and try to place
         }
         try {
            const b = applyBuildingDefaults(makeBuilding({ type }), options);
            b.level = 1;
            b.desiredLevel = 16;
            b.status = "building";
            td.building = b;
            td.explored = true;
            placed++;
         } catch (err) {
            // ignore placement errors
         }
      }
      return placed;
   };

   const placedCoal = placeMines(coalTiles, "CoalMine" as Building, 2);
   // building types for iron/copper are named '*MiningCamp' in this codebase
   const placedIron = placeMines(ironTiles, "IronMiningCamp" as Building, 2);
   const placedCopper = placeMines(copperTiles, "CopperMiningCamp" as Building, 2);

   if (placedCoal || placedIron || placedCopper) {
      summary.push(
         `${placedCoal} CoalMine`,
         `${placedIron} IronMiningCamp`,
         `${placedCopper} CopperMiningCamp`,
      );
   }

   showToast(`Prepared condo materials in top-right strip: ${summary.join(", ")}`);
   notifyGameStateUpdate();
}

// buildApartmentsLeftSide2 removed per user request: second apartment script killed off. Use
// buildApartmentsStripAndLeftColumn() which now builds apartments in batches until target 750.

export function replaceApartmentsWithCondos(): void {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const options = getGameOptions();
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   // Step 1: collect all Apartment tiles and remove all but 10 (keep left-most/top-most)
   const apartments: Array<{ tile: Tile; pt: { x: number; y: number } }> = [];
   for (const [xy, td] of gs.tiles) {
      if (td.building && td.building.type === ("Apartment" as Building)) {
         const p = tileToPoint(xy);
         apartments.push({ tile: xy, pt: p });
      }
   }
   // sort by x (leftmost first) then y (top to bottom)
   apartments.sort((a, b) => a.pt.x - b.pt.x || a.pt.y - b.pt.y);
   const keep = 10;
   let removed = 0;
   for (let i = keep; i < apartments.length; i++) {
      const td = gs.tiles.get(apartments[i].tile);
      if (!td) continue;
      // remove the apartment
      td.building = undefined;
      removed++;
   }

   // Step 2: build 750 Condos in vertical columns starting at x=0 (extreme left)
   const target = 750;
   let placed = 0;

   outer: for (let x = 0; x < size && placed < target; x++) {
      for (let y = 0; y < size && placed < target; y++) {
         const pt = { x, y };
         const tile = pointToTile(pt);
         const td = gs.tiles.get(tile);
         if (!td) continue;
         if (td.building) continue; // do not increment if occupied
         try {
            if (!checkBuildingMax("Condo" as Building, gs)) {
               // global limit reached for Condos
               break outer;
            }
         } catch (e) {
            // ignore and attempt placement
         }
         try {
            const created = applyBuildingDefaults(makeBuilding({ type: "Condo" as Building }), options);
            created.level = 0;
            created.desiredLevel = 10;
            created.status = "building";
            td.building = created;
            td.explored = true;
            placed++;
         } catch (err) {
            // ignore placement errors; do not increment placed
         }
      }
   }

   showToast(`Removed ${removed} Apartments; placed ${placed} Condos (target ${target})`);
   if (placed < target)
      showToast(`Could only place ${placed}/${target} Condos (map full or building limits)`);
   notifyGameStateUpdate();
}

export function prepareCNTowerMaterial(): void {
   // New implementation (user request):
   // - Operate on the rightmost 10-column vertical strip (columns size-10 .. size-1)
   // - Identify islands in that strip: contiguous rows where at least one tile in the
   //   strip has a building. Islands are separated by fully-empty strip-rows.
   // - Completely delete all buildings (within the strip bounds) in the first TWO islands
   //   encountered scanning from the top down. Stop after clearing the second island.
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const options = getGameOptions(); // not used here but kept for parity
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   const stripXStart = Math.max(0, size - 10);
   const stripXEnd = size - 1;

   const clearedCounts: Record<string, number> = {};
   let totalCleared = 0;

   const rowHasBuildingInStrip = (row: number): boolean => {
      for (let x = stripXStart; x <= stripXEnd; x++) {
         const td = gs.tiles.get(pointToTile({ x, y: row }));
         if (td?.building) return true;
      }
      return false;
   };

   // Pre-scan the strip to identify island ranges (start..end rows)
   const islands: Array<{ start: number; end: number }> = [];
   {
      let inIsland = false;
      let islandStart = 0;
      for (let ry = 0; ry < size; ry++) {
         if (rowHasBuildingInStrip(ry)) {
            if (!inIsland) {
               inIsland = true;
               islandStart = ry;
            }
         } else {
            if (inIsland) {
               islands.push({ start: islandStart, end: ry - 1 });
               inIsland = false;
            }
         }
      }
      if (inIsland) islands.push({ start: islandStart, end: size - 1 });
   }

   if (islands.length === 0) {
      showToast("prepareCNTowerMaterial: no islands found in rightmost strip to clear");
   } else {
      const ranges = islands.map((i) => `${i.start}-${i.end}`).join(", ");
      showToast(`prepareCNTowerMaterial: found ${islands.length} island(s) in strip: ${ranges}`);
   }

   // Now clear buildings in the first two islands (within strip bounds)
   const toClear = Math.min(2, islands.length);
   let islandsCleared = 0;
   for (let i = 0; i < toClear; i++) {
      const isl = islands[i];
      for (let ry = isl.start; ry <= isl.end; ry++) {
         for (let rx = stripXStart; rx <= stripXEnd; rx++) {
            const t = pointToTile({ x: rx, y: ry });
            const td = gs.tiles.get(t);
            if (!td) continue;
            if (td.building) {
               const bt = td.building.type;
               // debug log before clearing
               console.log(`prepareCNTowerMaterial: clearing ${bt} at ${rx},${ry}`);
               td.building = undefined;
               clearedCounts[bt] = (clearedCounts[bt] || 0) + 1;
               totalCleared++;
            }
         }
      }
      islandsCleared++;
   }

   const summary: string[] = [];
   if (totalCleared === 0) {
      showToast("prepareCNTowerMaterial: no buildings found in rightmost strip to clear");
   } else {
      for (const k of Object.keys(clearedCounts)) {
         summary.push(`${clearedCounts[k]} ${k}`);
      }
      showToast(`Cleared ${totalCleared} buildings from first ${Math.min(2, islandsCleared)} islands: ${summary.join(", ")}`);
   }

   // Now place the requested buildings in exact order, scanning from top of the rightmost
   // 10-column strip downward. Place on empty tiles only; if a tile is occupied, skip it.
   // Buildings start at level 0 and should target level 15.
   const buildPlan: Array<{ type: Building; count: number }> = [
      { type: "Brickworks" as Building, count: 4 },
      { type: "LumberMill" as Building, count: 4 },
      { type: "Glassworks" as Building, count: 1 },
      { type: "GarmentWorkshop" as Building, count: 1 },
      { type: "LensWorkshop" as Building, count: 1 },
      { type: "PrintingHouse" as Building, count: 4 },
      { type: "ActorsGuild" as Building, count: 2 },
      { type: "PublishingHouse" as Building, count: 1 },
      { type: "Stadium" as Building, count: 2 },
      { type: "MagazinePublisher" as Building, count: 4 },
      { type: "Embassy" as Building, count: 4 },
      { type: "MusiciansGuild" as Building, count: 2 },
      { type: "PoetrySchool" as Building, count: 2 },
      { type: "Brewery" as Building, count: 1 },
      { type: "PaperMaker" as Building, count: 1 },
      { type: "Sandpit" as Building, count: 1 },
      { type: "University" as Building, count: 4 },
      { type: "CottonMill" as Building, count: 1 },
      { type: "PaintersGuild" as Building, count: 1 },
      { type: "Museum" as Building, count: 3 },
      { type: "Courthouse" as Building, count: 3 },
      { type: "Mosque" as Building, count: 1 },
      { type: "Parliament" as Building, count: 3 },
      { type: "CottonPlantation" as Building, count: 1 },
      { type: "CheeseMaker" as Building, count: 1 }
   ];

   const placedPlanCounts: Record<string, number> = {};
   for (const b of buildPlan) placedPlanCounts[b.type] = 0;

   const targetLevel = 15;
   let lastPlacedRow: number | null = null;

   // For each plan entry, scan rows top->bottom and columns left->right within the strip,
   // placing until we've satisfied the requested count or exhausted the map.
   for (const entry of buildPlan) {
      let remaining = entry.count;
      // iterate rows top->bottom
      for (let yy = 0; yy < size && remaining > 0; yy++) {
         for (let xx = stripXStart; xx <= stripXEnd && remaining > 0; xx++) {
            const td = gs.tiles.get(pointToTile({ x: xx, y: yy }));
            if (!td) continue;
            if (td.building) continue; // skip occupied
            try {
               if (!checkBuildingMax(entry.type, gs)) {
                  // cannot place any more of this type globally
                  remaining = 0;
                  break;
               }
            } catch (e) {
               // if check fails for some reason, continue trying placements
            }
            try {
               const created = applyBuildingDefaults(makeBuilding({ type: entry.type }), options);
               created.level = 0;
               created.desiredLevel = targetLevel;
               created.status = "building";
               td.building = created;
               td.explored = true;
               remaining--;
               placedPlanCounts[entry.type] = (placedPlanCounts[entry.type] || 0) + 1;
               lastPlacedRow = yy;
            } catch (err) {
               // ignore and continue
            }
         }
      }
   }

   const placedSummary: string[] = [];
   for (const e of buildPlan) {
      const n = placedPlanCounts[e.type] || 0;
      placedSummary.push(`${n} ${e.type}`);
   }
   showToast(`Started construction in right strip: ${placedSummary.join(", ")}`);
   // Leave one empty row after the last placed row, then begin electrified placements
   const electrifiedPlan: Array<{ type: Building; count: number }> = [
      { type: "CoalPowerPlant" as Building, count: 1 },
      { type: "MovieStudio" as Building, count: 5 },
      { type: "RadioStation" as Building, count: 8 },
   ];

   let electStartY = 0;
   if (lastPlacedRow !== null) electStartY = Math.min(size - 1, lastPlacedRow + 2);

   const electPlacedCounts: Record<string, number> = {};
   for (const e of electrifiedPlan) electPlacedCounts[e.type] = 0;

   for (const entry of electrifiedPlan) {
      let remaining = entry.count;
      let yy = electStartY;
      while (yy < size && remaining > 0) {
         for (let xx = stripXStart; xx <= stripXEnd && remaining > 0; xx++) {
            const td = gs.tiles.get(pointToTile({ x: xx, y: yy }));
            if (!td) continue;
            if (td.building) continue;
            try {
               if (!checkBuildingMax(entry.type, gs)) {
                  remaining = 0;
                  break;
               }
            } catch (e) {
               // ignore
            }
            try {
               const created = applyBuildingDefaults(makeBuilding({ type: entry.type }), options);
               created.level = 1;
               created.desiredLevel = 16;
               created.status = "building";
               td.building = created;
               td.explored = true;
               remaining--;
               electPlacedCounts[entry.type] = (electPlacedCounts[entry.type] || 0) + 1;
            } catch (err) {
               // ignore
            }
         }
         if (remaining > 0) yy++;
      }
      // after finishing this entry, continue placing next entries starting at the same row where we left off
      // find the next available row (the lowest row that still may have space)
      // compute electStartY as the smallest y that still has an empty tile in the strip starting from current electStartY
      let foundRow = null;
      for (let ry = electStartY; ry < size; ry++) {
         for (let rx = stripXStart; rx <= stripXEnd; rx++) {
            const ttd = gs.tiles.get(pointToTile({ x: rx, y: ry }));
            if (ttd && !ttd.building) {
               foundRow = ry;
               break;
            }
         }
         if (foundRow !== null) break;
      }
      if (foundRow !== null) electStartY = foundRow;
      else break; // no more space
   }

   const electSummary: string[] = [];
   for (const e of electrifiedPlan) {
      electSummary.push(`${electPlacedCounts[e.type] || 0} ${e.type}`);
   }
   showToast(`Electrified placement started: ${electSummary.join(", ")}`);
   notifyGameStateUpdate();
}

   export function prepareAtomiumAndOxfordUniversity(): void {
      // Clearing-only variant: find the first fully-empty strip row, then delete
      // buildings row-by-row until a second fully-empty strip row is reached.
      // This lets the user place the wonders manually after the area is cleared.
      const gs = getGameState();
      if (!gs) {
         showToast("Game not ready");
         return;
      }
      const cityCfg = Config.City[gs.city];
      const size = cityCfg.size;

      const stripXStart = Math.max(0, size - 10);
      const stripXEnd = size - 1;

      const clearedCounts: Record<string, number> = {};
      let totalCleared = 0;
      // Delete everything in the rightmost strip scanning top-down and stop
      // when two fully-empty strip rows have been seen. An "empty strip row" is a
      // row where every tile in the 10-column strip has no building.
      let emptyRowsSeen = 0;
      let rowsScanned = 0;
      for (let ry = 0; ry < size; ry++) {
         // Determine whether this strip row is completely empty
         let rowHasBuilding = false;
         for (let rx = stripXStart; rx <= stripXEnd; rx++) {
            const td = gs.tiles.get(pointToTile({ x: rx, y: ry }));
            if (td?.building) {
               rowHasBuilding = true;
               break;
            }
         }

         // If the row is empty, increment the counter and stop if we've seen two
         if (!rowHasBuilding) {
            emptyRowsSeen++;
            if (emptyRowsSeen >= 2) {
               break; // stop processing further rows
            }
            // continue scanning — nothing to delete on this empty row
            continue;
         }

         // Row has at least one building: delete every building in the strip for this row
         rowsScanned++;
         for (let rx = stripXStart; rx <= stripXEnd; rx++) {
            const t = pointToTile({ x: rx, y: ry });
            const td = gs.tiles.get(t);
            if (!td) continue;
            if (td.building) {
               const bt = td.building.type;
               console.log(`prepareAtomiumAndOxfordUniversity: clearing ${bt} at ${rx},${ry}`);
               td.building = undefined;
               clearedCounts[bt] = (clearedCounts[bt] || 0) + 1;
               totalCleared++;
            }
         }
      }

         // After clearing each row, notify the game state and force a visual refresh
         // so any leftover sprites/graphics are removed immediately.
         if (totalCleared > 0) {
            try {
               notifyGameStateUpdate();
               const scene = Singleton().sceneManager.getCurrent(WorldScene);
               if (scene) scene.onGameStateChanged(getGameState());
            } catch (err) {
               // ignore any errors while attempting to refresh visuals
               console.warn('prepareAtomiumAndOxfordUniversity: visual refresh failed', err);
            }
         }

      const summary: string[] = [];
      if (totalCleared === 0) {
         showToast("prepareAtomiumAndOxfordUniversity: no buildings were cleared in the strip before the second empty row");
      } else {
         for (const k of Object.keys(clearedCounts)) summary.push(`${clearedCounts[k]} ${k}`);
         showToast(`Cleared ${totalCleared} buildings across ${rowsScanned} non-empty rows (stopped after seeing 2 empty rows): ${summary.join(", ")}`);
      }

      // --- Now place the requested buildings at the TOP of the strip, left->right
      // The user requested: IronForge x3, Sandpit x1, SteelMill x3, RebarPlant x3
   // Compact placement plan: array of { type, count } for readability
   const placementPlan: Array<{ type: Building | string; count: number }> = [
      { type: "Brickworks", count: 4 },
      { type: "LumberMill", count: 4 },
      { type: "IronForge", count: 3 },
      { type: "Sandpit", count: 1 },
      { type: "SteelMill", count: 3 },
      { type: "RebarPlant", count: 3 },
      { type: "ConcretePlant", count: 3 },
      { type: "ReinforcedConcretePlant", count: 6 },
      { type: "GunpowderMill", count: 2 },
      { type: "PoetrySchool", count: 3 },
      { type: "PaperMaker", count: 1 },
      { type: "Brewery", count: 1 },
      { type: "Stable", count: 1 },
      { type: "DynamiteWorkshop", count: 3 },
      { type: "RifleFactory", count: 3 },
      { type: "Shrine", count: 2 },
      { type: "GatlingGunFactory", count: 3 },
      { type: "University", count: 3 },
      { type: "ArtilleryFactory", count: 3 },
   ];

   // Expand plan into a flat sequence of types to place left->right
   const placementSequence: string[] = [];
   for (const entry of placementPlan) {
      for (let i = 0; i < entry.count; i++) placementSequence.push(entry.type as string);
   }

      const placedTopCounts: Record<string, number> = {};
      let placementIndex = 0;
      // Track the last row where we successfully placed a top item so we can
      // leave an empty row after it for post-top placements.
      let lastPlacedRow: number | null = null;
      const topRow = 0; // start at the very top of the strip and fill downward if necessary

      // Scan rows top->bottom and columns left->right within the strip, placing sequentially
      for (let yy = topRow; yy < size && placementIndex < placementSequence.length; yy++) {
         for (let xx = stripXStart; xx <= stripXEnd && placementIndex < placementSequence.length; xx++) {
            const td = gs.tiles.get(pointToTile({ x: xx, y: yy }));
            if (!td) continue;
            // skip occupied tiles
            if (td.building) continue;

            const desiredType = placementSequence[placementIndex] as Building;
            try {
               if (!checkBuildingMax(desiredType as Building, gs)) {
                  // cannot place more of this type globally; skip this placement and move on
                  console.warn(`prepareAtomiumAndOxfordUniversity: cannot place ${desiredType} due to building limits`);
                  placementIndex++;
                  continue;
               }
            } catch (e) {
               // if check fails, proceed to attempt placement
            }

            try {
               const created = applyBuildingDefaults(makeBuilding({ type: desiredType as Building }), getGameOptions());
               // Per user request: start at level 0 and target level 15
               created.level = 0;
               created.desiredLevel = 15;
               created.status = "building";
               td.building = created;
               td.explored = true;
               placedTopCounts[desiredType] = (placedTopCounts[desiredType] || 0) + 1;
               // record row used
               lastPlacedRow = yy;
               console.log(`prepareAtomiumAndOxfordUniversity: placed ${desiredType} at ${xx},${yy}`);
               placementIndex++;
            } catch (err) {
               console.error("prepareAtomiumAndOxfordUniversity: failed to place", desiredType, err);
               // continue trying next slots
               placementIndex++;
            }
         }
      }

      const placedSummary: string[] = [];
      for (const t of placementSequence) {
         const n = placedTopCounts[t] || 0;
         if (n > 0 && placedSummary.indexOf(`${n} ${t}`) === -1) placedSummary.push(`${n} ${t}`);
      }
      if (placementIndex < placementSequence.length) {
         showToast(`Placed on top row: ${placedSummary.join(", ")} (some placements may have been skipped due to occupied tiles or limits)`);
      } else {
         showToast(`Placed on top row: ${placedSummary.join(", ")}`);
      }

      // notify and force a scene refresh so changes are visible immediately
      notifyGameStateUpdate();
      try {
         const scene = Singleton().sceneManager.getCurrent(WorldScene);
         if (scene) scene.onGameStateChanged(getGameState());
      } catch (err) {
         // ignore
      }
      
      // --- Additional requested placement: leave one empty row, then place
      // 1 CoalPowerPlant, 20 UraniumEnrichmentPlant, 6 AtomicFacility at level 0->15
      // We'll start placing these beginning at row = topRow + 2 (one empty row after topRow)
      const postTopPlan: Array<{ type: Building; count: number }> = [
         { type: "CoalPowerPlant" as Building, count: 1 },
         { type: "UraniumEnrichmentPlant" as Building, count: 20 },
         { type: "AtomicFacility" as Building, count: 6 },
      ];

   // Determine a safe start row for post-top placements.
   // Requirement: leave one fully-empty strip row after the last placed top items
   // (e.g. after ArtilleryFactory) before starting CoalPowerPlant etc.
   let postTopStartRow = 0;
   if (lastPlacedRow !== null) {
      // Search for the first fully-empty strip row at or after lastPlacedRow+1
      let foundEmptyRow: number | null = null;
      for (let ry = lastPlacedRow + 1; ry < size; ry++) {
         let rowEmpty = true;
         for (let rx = stripXStart; rx <= stripXEnd; rx++) {
            const ttd = gs.tiles.get(pointToTile({ x: rx, y: ry }));
            if (ttd?.building) {
               rowEmpty = false;
               break;
            }
         }
         if (rowEmpty) {
            foundEmptyRow = ry;
            break;
         }
      }
      if (foundEmptyRow !== null) {
         // start one row after the empty row found to guarantee a single empty row
         postTopStartRow = Math.min(size - 1, foundEmptyRow + 1);
      } else {
         // fallback: leave one row after lastPlacedRow
         postTopStartRow = Math.min(size - 1, lastPlacedRow + 2);
      }
   } else {
      // No top placements happened; keep previous conservative default
      postTopStartRow = Math.min(size - 1, topRow + 2);
   }
      const postTopPlaced: Record<string, number> = {};
      for (const e of postTopPlan) postTopPlaced[e.type] = 0;

      for (const entry of postTopPlan) {
         let remaining = entry.count;
         for (let yy = postTopStartRow; yy < size && remaining > 0; yy++) {
            for (let xx = stripXStart; xx <= stripXEnd && remaining > 0; xx++) {
               const td = gs.tiles.get(pointToTile({ x: xx, y: yy }));
               if (!td) continue;
               if (td.building) continue;
               try {
                  if (!checkBuildingMax(entry.type, gs)) {
                     remaining = 0;
                     break;
                  }
               } catch (e) {
                  // ignore check errors and try to place
               }
               try {
                  const created = applyBuildingDefaults(makeBuilding({ type: entry.type }), getGameOptions());
                  created.level = 0;
                  created.desiredLevel = 15;
                  created.status = "building";
                  td.building = created;
                  td.explored = true;
                  remaining--;
                  postTopPlaced[entry.type] = (postTopPlaced[entry.type] || 0) + 1;
               } catch (err) {
                  // ignore and continue
                  remaining--;
               }
            }
         }
         // advance the start row for the next type so they continue filling downward
         // start next type at the same row where we left off; compute next available row
         let foundRow: number | null = null;
         for (let ry = postTopStartRow; ry < size; ry++) {
            for (let rx = stripXStart; rx <= stripXEnd; rx++) {
               const ttd = gs.tiles.get(pointToTile({ x: rx, y: ry }));
               if (ttd && !ttd.building) {
                  foundRow = ry;
                  break;
               }
            }
            if (foundRow !== null) break;
         }
         if (foundRow !== null) postTopStartRow = foundRow;
         else break; // no more space in strip
      }

      const postTopSummary: string[] = [];
      for (const k of Object.keys(postTopPlaced)) {
         if (postTopPlaced[k] > 0) postTopSummary.push(`${postTopPlaced[k]} ${k}`);
      }
      if (postTopSummary.length) showToast(`Post-top placements started: ${postTopSummary.join(', ')}`);
      
      // --- Now search the entire map for up to 2 Uranium deposit tiles and build mines at level 0->15
      const uraniumTiles: Tile[] = [];
      for (const t of Array.from(gs.tiles.keys()) as Tile[]) {
         const td = gs.tiles.get(t);
         if (!td) continue;
         if (td.building) continue; // only place on empty tiles
         if (td.deposit?.Uranium) uraniumTiles.push(t);
      }

      let placedUraniumMines = 0;
      const maxUraniumMines = 2;
      for (let i = 0; i < uraniumTiles.length && placedUraniumMines < maxUraniumMines; i++) {
         const tile = uraniumTiles[i];
         const td = gs.tiles.get(tile);
         if (!td) continue;
         try {
            if (!checkBuildingMax("UraniumMine" as Building, gs)) break;
         } catch (e) {
            // ignore and try
         }
         try {
            const created = applyBuildingDefaults(makeBuilding({ type: "UraniumMine" as Building }), getGameOptions());
            created.level = 0;
            created.desiredLevel = 15;
            created.status = "building";
            td.building = created;
            td.explored = true;
            placedUraniumMines++;
         } catch (err) {
            // ignore
         }
      }
      if (placedUraniumMines > 0) showToast(`Placed ${placedUraniumMines} UraniumMine(s) on deposit tiles`);
      else showToast("No available Uranium deposit tiles found for UraniumMine placement");

   }

export function prepareCloneLabs(): void {
   // Clear the rightmost 10-column strip scanning top-down until two fully-empty
   // strip rows are seen. Delete any building encountered. Stop when the second
   // empty strip row is reached after performing deletions.
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   const stripXStart = Math.max(0, size - 10);
   const stripXEnd = size - 1;

   const clearedCounts: Record<string, number> = {};
   let totalCleared = 0;
   let firstBlankSeen = false;

   for (let ry = 0; ry < size; ry++) {
      // check whether this strip row is completely empty
      let rowHasBuilding = false;
      for (let rx = stripXStart; rx <= stripXEnd; rx++) {
         const td = gs.tiles.get(pointToTile({ x: rx, y: ry }));
         if (td?.building) {
            rowHasBuilding = true;
            break;
         }
      }

      if (!rowHasBuilding) {
         // empty row
         if (!firstBlankSeen) {
            firstBlankSeen = true;
            console.log(`prepareCloneLabs: first blank strip row at ${ry}`);
            // continue scanning for second blank row
            continue;
         }
         // second empty row encountered
         if (totalCleared > 0) {
            console.log(`prepareCloneLabs: second blank strip row at ${ry}, stopping (cleared ${totalCleared})`);
            break;
         }
         // haven't deleted anything yet - keep scanning
         continue;
      }

      // Row has at least one building: delete every building in the strip for this row
      for (let rx = stripXStart; rx <= stripXEnd; rx++) {
         const t = pointToTile({ x: rx, y: ry });
         const td = gs.tiles.get(t);
         if (!td) continue;
         if (td.building) {
            const bt = td.building.type;
            console.log(`prepareCloneLabs: clearing ${bt} at ${rx},${ry}`);
            td.building = undefined;
            clearedCounts[bt] = (clearedCounts[bt] || 0) + 1;
            totalCleared++;
         }
      }
   }

   if (totalCleared === 0) {
      showToast("prepareCloneLabs: no buildings were cleared in the right strip");
   } else {
      const summary: string[] = [];
      for (const k of Object.keys(clearedCounts)) summary.push(`${clearedCounts[k]} ${k}`);
      showToast(`prepareCloneLabs: cleared ${totalCleared} buildings: ${summary.join(", ")}`);
      // force an immediate visual refresh so artefacts are removed
      try {
         notifyGameStateUpdate();
         const scene = Singleton().sceneManager.getCurrent(WorldScene);
         if (scene) scene.onGameStateChanged(getGameState());
      } catch (err) {
         console.warn('prepareCloneLabs: visual refresh failed', err);
      }
   }
}

/**
 * Build a plan inside a vertical strip region.
 * - Deletes all "normal" (non-wonder) buildings inside the rectangular strip
 *   defined by columns [stripXStart .. stripXStart+width-1] and rows [rowStart .. rowEnd].
 * - Leaves wonders/special buildings intact.
 * - Notifies the game/UI to refresh graphics.
 * - Places the requested buildings in order and quantity. Placements are legal
 *   (create building objects with status "building" and desired level so the
 *   normal construction system will handle consumption/leveling). Existing
 *   wonders will not cause failure; only empty tiles are used for placement.
 *
 * Parameters:
 *  - stripXStart: left-most column of the strip (0-based)
 *  - width: number of columns in the strip
 *  - rowStart,rowEnd: inclusive row bounds to operate within (0-based)
 *  - plan: array of { type: Building, count: number, targetLevel?: number }
 */
export function buildStripPlan(
   stripXStart: number,
   width: number,
   rowStart: number,
   rowEnd: number,
   plan: Array<{ type: Building; count: number; targetLevel?: number }>,
   opts?: { preserveDeposits?: boolean; upgradeExisting?: boolean },
): Record<string, number> {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return {};
   }
   const gameOptions = getGameOptions();
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   // Clamp and compute bounds
   const xStart = Math.max(0, Math.min(size - 1, stripXStart));
   const xEnd = Math.max(0, Math.min(size - 1, stripXStart + Math.max(0, width) - 1));
   const yStart = Math.max(0, Math.min(size - 1, rowStart));
   const yEnd = Math.max(0, Math.min(size - 1, rowEnd));

   // NOTE: Deletion/clearing is now the responsibility of `clearStripArea`.
   // This function performs placement only and assumes the caller cleared the
   // region beforehand if needed.

   // Phase: Place buildings in order as requested. Only place on empty tiles.
   const placedCounts: Record<string, number> = {};
   for (const entry of plan) placedCounts[entry.type] = 0;

   for (const entry of plan) {
      let remaining = entry.count;
      const targetLevel = entry.targetLevel ?? 0;
      // Scan rows top->bottom (yStart..yEnd) and columns left->right (xStart..xEnd)
      for (let ry = yStart; ry <= yEnd && remaining > 0; ry++) {
         for (let rx = xStart; rx <= xEnd && remaining > 0; rx++) {
               const td = gs.tiles.get(pointToTile({ x: rx, y: ry }));
               if (!td) continue;
               // If occupied and same type and caller wants upgrades, request desiredLevel and count as placed
               if (td.building) {
                  if (opts?.upgradeExisting && td.building.type === entry.type) {
                     if ((td.building.desiredLevel ?? td.building.level) < targetLevel) {
                        td.building.desiredLevel = targetLevel;
                     }
                     placedCounts[entry.type] = (placedCounts[entry.type] || 0) + 1;
                     remaining--;
                  }
                  // otherwise skip occupied tiles
                  continue;
               }
            try {
               if (!checkBuildingMax(entry.type, gs)) {
                  // Cannot place more of this type due to global limits; stop trying for this type
                  remaining = 0;
                  break;
               }
            } catch (e) {
               // If checkBuildingMax throws, proceed attempting placement
            }
            try {
               const created = applyBuildingDefaults(makeBuilding({ type: entry.type }), gameOptions);
               created.level = 0;
               created.desiredLevel = targetLevel;
               created.status = "building";
               td.building = created;
               td.explored = true;
               remaining--;
               placedCounts[entry.type] = (placedCounts[entry.type] || 0) + 1;
            } catch (err) {
               // ignore placement errors and continue scanning
            }
         }
      }
      // If still remaining after scanning the region, we attempted best-effort placement
      if (remaining > 0) {
         showToast(`Warning: Could only place ${entry.count - remaining}/${entry.count} ${entry.type} (map full or limits)`);
      }
   }

   // Report placements
   const placedSummary: string[] = [];
   for (const k of Object.keys(placedCounts)) {
      const n = placedCounts[k] || 0;
      placedSummary.push(`${n} ${k}`);
   }
   showToast(`Placement complete in strip: ${placedSummary.join(", ")}`);

   // Final refresh
   try {
      notifyGameStateUpdate();
      const scene = Singleton().sceneManager.getCurrent(WorldScene);
      if (scene) scene.onGameStateChanged(getGameState());
   } catch (err) {
      console.warn("buildStripPlan: final visual refresh failed", err);
   }
   return placedCounts;
}

/**
 * Clear (delete) buildings inside a rectangular region defined by column and row bounds.
 * Keeps wonders/special buildings and preserves deposit-extracting buildings when
 * the building's deposit keys overlap the tile deposit (i.e., mines on matching deposits).
 * Returns a map of cleared building type -> count. Also triggers a UI refresh.
 */
export function clearStripArea(
   colFrom: number,
   colTo: number,
   rowFrom: number,
   rowTo: number,
   opts?: { preserveDeposits?: boolean },
): Record<string, number> {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return {};
   }
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   // Clamp bounds
   const xStart = Math.max(0, Math.min(size - 1, Math.min(colFrom, colTo)));
   const xEnd = Math.max(0, Math.min(size - 1, Math.max(colFrom, colTo)));
   const yStart = Math.max(0, Math.min(size - 1, Math.min(rowFrom, rowTo)));
   const yEnd = Math.max(0, Math.min(size - 1, Math.max(rowFrom, rowTo)));

   const clearedCounts: Record<string, number> = {};
   let totalCleared = 0;

   for (let ry = yStart; ry <= yEnd; ry++) {
      for (let rx = xStart; rx <= xEnd; rx++) {
         const t = pointToTile({ x: rx, y: ry });
         const td = gs.tiles.get(t);
         if (!td || !td.building) continue;
         const bt = td.building.type;
         const def = Config.Building[bt as Building];
         // Keep wonders/specials
         if (def && def.special != null) continue;
         // Optionally preserve deposit-extracting buildings on matching deposits
         if (opts?.preserveDeposits && td.deposit && def && def.deposit) {
            let match = false;
            for (const k of Object.keys(def.deposit)) {
               if ((td.deposit as Record<string, unknown>)[k]) {
                  match = true;
                  break;
               }
            }
            if (match) continue;
         }
         // Otherwise delete
         td.building = undefined;
         clearedCounts[bt] = (clearedCounts[bt] || 0) + 1;
         totalCleared++;
      }
   }

   if (totalCleared > 0) {
      const summary: string[] = [];
      for (const k of Object.keys(clearedCounts)) summary.push(`${clearedCounts[k]} ${k}`);
      showToast(`Cleared ${totalCleared} buildings in strip: ${summary.join(", ")}`);
      try {
         notifyGameStateUpdate();
         const scene = Singleton().sceneManager.getCurrent(WorldScene);
         if (scene) scene.onGameStateChanged(getGameState());
      } catch (err) {
         console.warn("clearStripArea: visual refresh failed", err);
      }
   } else {
      showToast("No non-wonder buildings found to clear in strip");
   }

   return clearedCounts;
}

/**
 * Named-arguments wrapper for buildStripPlan.
 * Use this when you want true "named parameters" in call sites.
 */
export function buildStripPlanNamed(args: {
   stripXStart: number;
   width: number;
   rowStart: number;
   rowEnd: number;
   plan: Array<{ type: Building; count: number; targetLevel?: number }>;
   opts?: { preserveDeposits?: boolean; upgradeExisting?: boolean };
}): Record<string, number> {
   return buildStripPlan(
      args.stripXStart,
      args.width,
      args.rowStart,
      args.rowEnd,
      args.plan,
      args.opts,
   );
}
