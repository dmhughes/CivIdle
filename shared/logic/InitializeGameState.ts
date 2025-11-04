import type { Building } from "../definitions/BuildingDefinitions";
<<<<<<< HEAD
import type { City } from "../definitions/CityDefinitions";
import { forEach, keysOf, pointToTile, shuffle, tileToPoint, type Tile } from "../utilities/Helper";
=======
import { isChristmas } from "../definitions/TimedBuildingUnlock";
import { forEach, keysOf, pointToTile, shuffle } from "../utilities/Helper";
>>>>>>> upstream/main
import { getServerNow } from "../utilities/ServerNow";
import { applyBuildingDefaults, getRandomEmptyTiles, isSpecialBuilding } from "./BuildingLogic";
import { Config } from "./Config";
import type { GameOptions, GameState } from "./GameState";
import { getGrid } from "./IntraTickCache";
import { unlockTech } from "./TechLogic";
import { ensureTileFogOfWar, sortByDistance } from "./TerrainLogic";
import type { ICentrePompidouBuildingData } from "./Tile";
import { makeBuilding } from "./Tile";

export function initializeGameState(gameState: GameState, options: GameOptions) {
   const grid = getGrid(gameState);
   const center = grid.center();
   const centerXy = pointToTile(center);

   // Create the tile entries but do NOT mark them explored yet.
   // We postpone marking tiles explored until after unique/natural
   // buildings (like CentrePompidou) are placed so the random
   // placement logic can find empty, unexplored tiles.
   grid.forEach((point) => {
      const xy = pointToTile(point);
      if (gameState.tiles.has(xy)) {
         return;
      }
      gameState.tiles.set(xy, {
         tile: xy,
         deposit: {},
         explored: false,
      });
   });

   const opt = Object.assign({}, options, { defaultBuildingLevel: 1 });

   const centerTile = gameState.tiles.get(centerXy);
   if (centerTile) {
      centerTile.building = applyBuildingDefaults(
         makeBuilding({
            type: "Headquarter",
            level: 1,
            status: "completed",
         }),
         opt,
      );
   }

   // forEach(Config.Tech, (k, v) => {
   //    if (v.column === 0) {
   //       unlockTech(k, getTechConfig(gameState), gameState);
   //    }
   // });
   forEach(Config.Tech, (k, v) => {
      if (v.column === 0) {
         unlockTech(k, false, gameState);
      }
   });

   const wood = sortByDistance((tile) => !!tile.deposit.Wood && !tile.building, centerXy, gameState);
   if (wood.length > 0) {
      wood[0].building = applyBuildingDefaults(
         makeBuilding(
            makeBuilding({
               type: "LoggingCamp",
               level: 1,
               status: "completed",
            }),
         ),
         opt,
      );
   }
   if (wood.length > 1) {
      wood[1].explored = true;
   }

   const stone = sortByDistance((tile) => !!tile.deposit.Stone && !tile.building, centerXy, gameState);
   if (stone.length > 0) {
      stone[0].building = applyBuildingDefaults(
         makeBuilding({
            type: "StoneQuarry",
            level: 1,
            status: "completed",
         }),
         opt,
      );
   }
   if (stone.length > 1) {
      stone[1].explored = true;
   }

   const water = sortByDistance((tile) => !!tile.deposit.Water && !tile.building, centerXy, gameState);
   if (water.length > 0) {
      water[0].building = applyBuildingDefaults(
         makeBuilding({
            type: "Aqueduct",
            level: 1,
            status: "completed",
         }),
         opt,
      );
   }
   if (water.length > 1) {
      water[1].explored = true;
   }

   gameState.tiles.forEach((tile, xy) => {
      if (tile.building) {
         ensureTileFogOfWar(xy, 0, gameState);
      }
   });

   const naturalWonders = keysOf(Config.City[gameState.city].naturalWonders);

   const now = getServerNow();
   if (now && isChristmas(new Date(now))) {
      naturalWonders.push("Lapland");
      naturalWonders.push("RockefellerCenterChristmasTree");
   }

   if (gameState.city === "Australian") {
      const candidates: Building[] = [];
      forEach(Config.City, (city, def) => {
         if (city !== "Australian") {
            forEach(def.naturalWonders, (nw) => {
               candidates.push(nw);
            });
         }
      });
      if (candidates.length > 0) {
         const result = shuffle(candidates)[0];
         naturalWonders.push(result);
      }
   }

   getRandomEmptyTiles(naturalWonders.length, gameState).forEach((xy, i) => {
      const tile = gameState.tiles.get(xy);
      if (tile) {
         tile.building = makeBuilding({
            type: naturalWonders[i],
            level: 1,
            status: "completed",
         });
      }
   });

   // Ensure Centre Pompidou exists on startup — place it deterministically
   const hasPompidou = Array.from(gameState.tiles.values()).some(
      (tile) => tile.building?.type === "CentrePompidou",
   );

   if (!hasPompidou) {
      const allCities = new Set<City>(Object.keys(Config.City) as City[]);

      const sortedTiles = Array.from(gameState.tiles.entries()).sort((a, b) => {
         const pa = tileToPoint(a[0] as Tile);
         const pb = tileToPoint(b[0] as Tile);
         const dy = pb.y - pa.y;
         if (dy !== 0) return dy;
         return pb.x - pa.x;
      });

      const createPompidou = (): ICentrePompidouBuildingData => {
         const created = applyBuildingDefaults(
            makeBuilding({ type: "CentrePompidou", level: 1, status: "completed" }),
            opt,
         ) as ICentrePompidouBuildingData;
         created.cities = new Set(allCities);
         const level = Math.max(1, created.cities.size);
         created.level = level;
         created.desiredLevel = level;
         created.status = "completed";
         return created;
      };

      let placed = false;

      // Prefer an empty tile closest to bottom-right
      for (const [, td] of sortedTiles) {
         if (!td.building) {
            const created = createPompidou();
            td.explored = true;
            td.building = created;
            placed = true;
            break;
         }
      }

      // Replace first non-special building if still not placed
      if (!placed) {
         for (const [, td] of sortedTiles) {
            if (td.building && !isSpecialBuilding(td.building.type)) {
               td.explored = true;
               td.building = createPompidou();
               placed = true;
               break;
            }
         }
      }

      // Final fallback: force into the bottom-right-most tile
      if (!placed) {
         for (const [, td] of sortedTiles) {
            td.explored = true;
            td.building = createPompidou();
            placed = true;
            break;
         }
      }
   }

      // Finally, mark all tiles explored to preserve the previous behaviour
      // of clearing fog on new game / rebirth. This is done after placing
      // special and natural wonders so the placement helpers can operate.
      gameState.tiles.forEach((tile) => {
         tile.explored = true;
      });
}
