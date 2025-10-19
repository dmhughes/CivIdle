import type { Building } from "../../../shared/definitions/BuildingDefinitions";
import { applyBuildingDefaults, checkBuildingMax, findSpecialBuilding } from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import type { GameState } from "../../../shared/logic/GameState";
import { getGameOptions, getGameState, notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { makeBuilding } from "../../../shared/logic/Tile";
import { pointToTile, tileToPoint, type Tile } from "../../../shared/utilities/Helper";
import { showToast } from "../ui/GlobalModal";

// Find the nearest empty tile (no building) to a centre point within maxRadius.
function findNearestEmptyTile(center: { x: number; y: number }, maxRadius: number, size: number, gs: GameState): Tile | null {
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

   const takeAndPlace = (list: Tile[], type: Building, limit: number, desiredLevel: number, counterRef: (n: number) => void) => {
         for (let i = 0; i < Math.min(limit, list.length); i++) {
            const xy = list[i];
            const b = applyBuildingDefaults(makeBuilding({ type }), options);
            // Ensure the building starts at level 1 and requests the desiredLevel so normal construction occurs
            b.level = 1;
            b.desiredLevel = desiredLevel;
            b.status = "building";
            const td = gs.tiles.get(xy);
            if (td) {
               td.building = b;
               td.explored = true;
               counterRef(1);
            }
         }
   };

   // Try lower-right first
   takeAndPlace(loggingTiles, "LoggingCamp", 6, 16, (n) => { placedLogging += n; });
   takeAndPlace(stoneTiles, "StoneQuarry", 6, 16, (n) => { placedStone += n; });
   takeAndPlace(waterTiles, "Aqueduct", 6, 16, (n) => { placedWater += n; });

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
   takeAndPlace(loggingUpper, "LoggingCamp", needed, 16, (n: number) => { placedLogging += n; });
      }
      if (placedStone < 6) {
         const needed = 6 - placedStone;
   takeAndPlace(stoneUpper, "StoneQuarry", needed, 16, (n: number) => { placedStone += n; });
      }
      if (placedWater < 6) {
         const needed = 6 - placedWater;
   takeAndPlace(waterUpper, "Aqueduct", needed, 16, (n: number) => { placedWater += n; });
      }
   }

   showToast(`Placed ${placedLogging} Logging Camps, ${placedStone} Stone Quarries, ${placedWater} Aqueducts`);
   // Notify the UI/game state that tiles changed so construction can proceed
   notifyGameStateUpdate();

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
                  const stats = applyBuildingDefaults(makeBuilding({ type: "Statistics" as Building }), options);
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

export function buildApartmentsStripAndLeftColumn(): void {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const options = getGameOptions();
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   // Top-right strip: 10 tiles wide from right edge inward, along the top rows
      // Top-right area: start 10 tiles left of the top-right corner and fill rows left->right
      const startX = Math.max(0, size - 1 - 10);
      const startY = 0;

      // Desired counts for the top area
      const topPlan: Array<{ type: Building; count: number }> = [
         { type: "Brickworks" as Building, count: 4 },
         { type: "LumberMill" as Building, count: 4 },
         { type: "Bakery" as Building, count: 8 },
         { type: "PoultryFarm" as Building, count: 15 },
         { type: "CheeseMaker" as Building, count: 12 },
         { type: "FlourMill" as Building, count: 2 },
         { type: "DairyFarm" as Building, count: 2 },
      ];

      // Place or upgrade buildings to required level (16)
      const requiredTopLevel = 16;
      const topSummary: string[] = [];

      // iterate rows starting at (startX,startY), fill left->right until reach map edge, then next row below
      let planIndex = 0;
      let placedForCurrent = 0;
      let x = startX;
      let y = startY;
      // Continue until we've attempted all plan items or we've exhausted the map
      let mapTilesVisited = 0;
      const maxMapTiles = size * size;
      while (planIndex < topPlan.length && mapTilesVisited < maxMapTiles) {
         if (x >= size) {
            // go to next row starting directly below the initial row
            y++;
            x = startX;
            if (y >= size) break; // out of map
            continue;
         }
         const tile = pointToTile({ x, y });
         const td = gs.tiles.get(tile);
         mapTilesVisited++;
      // if tile is missing or occupied by a non-placeable item, skip
      if (td?.building) {
         // If tile is occupied (by a resource mine, wonder, or other building),
         // do not count it toward the placement quota. If it's the same type
         // we still upgrade it to the required level, but we don't increment
         // the placed counter here (existing buildings are counted in the
         // later global scan).
         const currentPlan = topPlan[planIndex];
         if (td.building.type === currentPlan.type) {
            // Queue an upgrade to the required level instead of forcing it complete.
            // This lets the normal construction/resource consumption occur.
            if ((td.building.desiredLevel ?? td.building.level) < requiredTopLevel) {
               td.building.desiredLevel = requiredTopLevel;
            }
            // do not increment placedForCurrent for occupied tiles
         }
            // move to next tile
            x++;
            // if we've reached desired count for current plan entry, advance
            if (placedForCurrent >= topPlan[planIndex].count) {
               topSummary.push(`${placedForCurrent} ${topPlan[planIndex].type}`);
               planIndex++;
               placedForCurrent = 0;
            }
            continue;
         }
         // td exists and is empty, attempt to place
         if (td && !td.building) {
            const currentPlan = topPlan[planIndex];
               try {
                  if (checkBuildingMax(currentPlan.type, gs)) {
                  // Place as level 1 with a desiredLevel so the game will perform construction and consume resources
                  const createdTop = applyBuildingDefaults(makeBuilding({ type: currentPlan.type }), options);
                  createdTop.level = 1;
                  createdTop.desiredLevel = requiredTopLevel;
                  createdTop.status = "building";
                  td.building = createdTop;
                  td.explored = true;
                  placedForCurrent++;
               } else {
                  // cannot place more of this type (max reached) - but we can try to count existing ones elsewhere later
               }
            } catch (e) {
               // ignore and continue
            }
         }
         x++;
         // if we've reached desired count for current plan entry, advance
         if (placedForCurrent >= topPlan[planIndex].count) {
            topSummary.push(`${placedForCurrent} ${topPlan[planIndex].type}`);
            planIndex++;
            placedForCurrent = 0;
         }
      }
      // if we broke out and still have remaining plan entries, try to find and upgrade existing buildings elsewhere
      while (planIndex < topPlan.length) {
         const currentPlan = topPlan[planIndex];
         let countFound = 0;
         // scan all tiles for existing buildings of this type and upgrade them
         for (const [tileKey, tileData] of gs.tiles) {
            if (countFound >= currentPlan.count) break;
         if (tileData.building && tileData.building.type === currentPlan.type) {
            if ((tileData.building.desiredLevel ?? tileData.building.level) < requiredTopLevel) {
               tileData.building.desiredLevel = requiredTopLevel;
            }
            countFound++;
         }
         }
         topSummary.push(`${countFound} ${currentPlan.type} (upgraded existing)`);
         planIndex++;
      }

      showToast(`Top area setup: ${topSummary.join(", ")}`);

   // Left-side vertical strip: ensure exactly 400 Apartments total.
   const desiredTotal = 400;
   let existingApartments = 0;
   // First pass: count and upgrade existing Apartments to level 10 (do not count them as placed here)
   for (const [, tileData] of gs.tiles) {
      if (tileData.building && tileData.building.type === ("Apartment" as Building)) {
         existingApartments++;
         // Request upgrade to level 10, allow normal construction to proceed
         if ((tileData.building.desiredLevel ?? tileData.building.level) < 10) {
            tileData.building.desiredLevel = 10;
         }
      }
   }

   let remaining = Math.max(0, desiredTotal - existingApartments);
   let placedApartments = 0;
   if (remaining === 0) {
      showToast(`Already have ${existingApartments} Apartments (upgraded to level 10 where necessary)`);
   } else {
      // Fill columns left-to-right, top-to-bottom, only placing on empty tiles
      const maxCols = Math.min(size, Math.ceil(desiredTotal / Math.max(1, size)));
      outer: for (let cx = 0; cx < size && remaining > 0; cx++) {
         for (let y = 0; y < size && remaining > 0; y++) {
            const pt = { x: cx, y };
            const tile = pointToTile(pt);
            const td = gs.tiles.get(tile);
            if (!td) continue;
            if (td.building) continue; // only place on empty tiles
            try {
               if (!checkBuildingMax("Apartment" as Building, gs)) {
                  // building max prevents further placement
                  break outer;
               }
            } catch (e) {
               // ignore and proceed
            }
            const createdApartment = applyBuildingDefaults(makeBuilding({ type: "Apartment" as Building }), options);
            createdApartment.level = 1;
            createdApartment.desiredLevel = 10;
            createdApartment.status = "building";
            td.building = createdApartment;
            td.explored = true;
            placedApartments++;
            remaining--;
         }
      }
      const totalNow = existingApartments + placedApartments;
      showToast(`Placed ${placedApartments} Apartments; total now ${totalNow}/${desiredTotal}`);
      if (totalNow < desiredTotal) {
         showToast(`Could only reach ${totalNow}/${desiredTotal} Apartments (map size or building limits)`);
      }
   }
   notifyGameStateUpdate();
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

   // Top-right strip: same start as other scripts (10 tiles wide)
   const startX = Math.max(0, size - 1 - 10);

   const plan: Array<{ type: Building; count: number }> = [
      { type: "Sandpit" as Building, count: 1 },
      { type: "SteelMill" as Building, count: 4 },
      { type: "RebarPlant" as Building, count: 5 },
      { type: "ConcretePlant" as Building, count: 5 },
      { type: "ReinforcedConcretePlant" as Building, count: 14 },
      { type: "Pizzeria" as Building, count: 25 },
      { type: "IronForge" as Building, count: 5 },
   ];

   const requiredLevel = 16;
   const placedCounts: Record<string, number> = {};
   for (const p of plan) placedCounts[p.type] = 0;

   let planIndex = 0;
   let placedForCurrent = 0;

   // Iterate row-by-row from top (y=0) downward, and within each row from startX -> right edge
   for (let y = 0; y < size && planIndex < plan.length; y++) {
      for (let x = startX; x < size && planIndex < plan.length; x++) {
         const tile = pointToTile({ x, y });
         const td = gs.tiles.get(tile);
         if (!td) continue;
         // Only place on empty tiles; occupied tiles do not count toward the plan
         if (td.building) continue;

         const current = plan[planIndex];
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
      summary.push(`${placedCoal} CoalMine`, `${placedIron} IronMiningCamp`, `${placedCopper} CopperMiningCamp`);
   }

   showToast(`Prepared condo materials in top-right strip: ${summary.join(', ')}`);
   notifyGameStateUpdate();
}

export function buildApartmentsLeftSide2(): void {
   const gs = getGameState();
   if (!gs) {
      showToast("Game not ready");
      return;
   }
   const options = getGameOptions();
   const cityCfg = Config.City[gs.city];
   const size = cityCfg.size;

   const target = 350;
   let placed = 0;

   outer: for (let x = 0; x < size && placed < target; x++) {
      for (let y = 0; y < size && placed < target; y++) {
         const pt = { x, y };
         const tile = pointToTile(pt);
         const td = gs.tiles.get(tile);
         if (!td) continue;
         // Only place on empty tiles; do not increment counter if tile not empty
         if (td.building) continue;
         try {
            if (!checkBuildingMax("Apartment" as Building, gs)) {
               // global limit reached; stop trying
               break outer;
            }
         } catch (e) {
            // ignore and attempt placement
         }
         try {
            const created = applyBuildingDefaults(makeBuilding({ type: "Apartment" as Building }), options);
            // Start at level 0 and request level 10 so construction occurs normally
            created.level = 0;
            created.desiredLevel = 10;
            created.status = "building";
            td.building = created;
            td.explored = true;
            placed++;
         } catch (err) {
            // ignore failures and continue; do not increment placed
         }
      }
   }

   showToast(`Placed ${placed} Apartments (target ${target})`);
   notifyGameStateUpdate();
}

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
   apartments.sort((a, b) => (a.pt.x - b.pt.x) || (a.pt.y - b.pt.y));
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
   if (placed < target) showToast(`Could only place ${placed}/${target} Condos (map full or building limits)`);
   notifyGameStateUpdate();
}
