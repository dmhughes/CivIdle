import { useEffect, useMemo, useState } from "react";
import type { Building } from "../../../shared/definitions/BuildingDefinitions";
import type { Material } from "../../../shared/definitions/MaterialDefinitions";
import { applyToAllBuildings, getTotalBuildingCost, isBuildingUpgradable } from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import { notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { getResourceIO, getTypeBuildings } from "../../../shared/logic/IntraTickCache";
import { Tick } from "../../../shared/logic/TickLogic";
import type { IBuildingData } from "../../../shared/logic/Tile";
import { formatHMS, keysOf } from "../../../shared/utilities/Helper";
import type { PartialTabulate } from "../../../shared/utilities/TypeDefinitions";
import { useGameState } from "../Global";
import { hideModal, showToast } from "./GlobalModal";
import { FormatNumber } from "./HelperComponents";

export function BuildingManagerModal(): React.ReactNode {
   const gs = useGameState();

   const typeMap = getTypeBuildings(gs);
   const io = getResourceIO(gs);
   const [now, setNow] = useState<number>(Date.now());

   useEffect(() => {
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
   }, []);

   const rows = useMemo(() => {
      const result: Array<{
         type: Building;
         highestLevel: number;
            minLevel: number;
         count: number;
         cost: PartialTabulate<Material>;
         etaMs: number;
         etaComputedAt: number;
         ready: boolean;
         targetLevel: number;
            allSame: boolean;
         anyUpgrading: boolean;
      }> = [];
      typeMap.forEach((map, b) => {
         if (!map || map.size <= 0) return;
         if (!isBuildingUpgradable(b)) return;
         let highest = 0;
         const levels: number[] = [];
         map.forEach((tile) => {
            const lvl = tile.building.level;
            levels.push(lvl);
            if (lvl > highest) highest = lvl;
         });
         // detect whether all instances are the same level and compute min level
         let etaMs = 0;
         const minLevel = levels.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY) || 0;
         let allSame = true;
         for (const lvl of levels) {
            if (lvl !== highest) {
               allSame = false;
               break;
            }
         }

         // determine anyUpgrading
         let anyUpgrading = false;
         map.forEach((tile) => {
            const status = tile.building?.status;
            if (status === "upgrading" || status === "building") anyUpgrading = true;
         });

         const haveResources = (cost: PartialTabulate<Material>): boolean => {
            for (const res of keysOf(cost)) {
               const need = cost[res] ?? 0;
               const have = Tick.current.resourceAmount.get(res) ?? 0;
               if (have < need) return false;
            }
            return true;
         };

         let ready = false;
         let targetLevel = highest;
         // Determine targetLevel depending on whether all instances are the same
         if (!allSame) {
            // cost to bring all lower instances up to current highest
            const costToHighest: PartialTabulate<Material> = {};
            map.forEach((tile) => {
               if (tile.building.level >= highest) return;
               const c = getTotalBuildingCost({ type: b }, tile.building.level, highest);
               keysOf(c).forEach((res) => {
                  costToHighest[res] = (costToHighest[res] ?? 0) + (c[res] ?? 0);
               });
            });
            // if we can't afford to bring everyone to highest, target stays highest and ETA is for that cost
            if (!haveResources(costToHighest)) {
               targetLevel = highest;
               // compute ETA for costToHighest
               keysOf(costToHighest).forEach((res) => {
                  const needed = costToHighest[res] ?? 0;
                  const current = Tick.current.resourceAmount.get(res) ?? 0;
                  if (current >= needed) return;
                  const surplus = (io.theoreticalOutput.get(res) ?? 0) - (io.theoreticalInput.get(res) ?? 0);
                  let ms = Number.POSITIVE_INFINITY;
                  if (surplus > 0) ms = Math.max(0, (needed - current) / surplus) * 1000;
                  if (ms > etaMs) etaMs = ms;
               });
            } else {
               // we can afford to bring all to highest; find highest uniform target affordable
               const def = Config.Building[b] as unknown as { max?: number } | undefined;
               const upperBound = def?.max ?? highest + 100;
               const affordable = (tgt: number): boolean => {
                  const acc: PartialTabulate<Material> = {};
                  map.forEach((tile) => {
                     if (tile.building.level >= tgt) return;
                     const c = getTotalBuildingCost({ type: b }, tile.building.level, tgt);
                     keysOf(c).forEach((res) => {
                        acc[res] = (acc[res] ?? 0) + (c[res] ?? 0);
                     });
                  });
                  return haveResources(acc);
               };
               let low = highest;
               let high = upperBound;
               while (low < high) {
                  const mid = Math.ceil((low + high + 1) / 2);
                  if (affordable(mid)) low = mid;
                  else high = mid - 1;
               }
               targetLevel = low;
            }
         } else {
            // All same level -> determine if they can all be upgraded by 1
            const costToNext: PartialTabulate<Material> = {};
            map.forEach((tile) => {
               const c = getTotalBuildingCost({ type: b }, tile.building.level, tile.building.level + 1);
               keysOf(c).forEach((res) => {
                  costToNext[res] = (costToNext[res] ?? 0) + (c[res] ?? 0);
               });
            });
            const canAffordNext = haveResources(costToNext);
            if (!canAffordNext) {
               // show deficits for next-level upgrade and disable
               targetLevel = highest + 1;
               // compute ETA for costToNext
               keysOf(costToNext).forEach((res) => {
                  const needed = costToNext[res] ?? 0;
                  const current = Tick.current.resourceAmount.get(res) ?? 0;
                  if (current >= needed) return;
                  const surplus = (io.theoreticalOutput.get(res) ?? 0) - (io.theoreticalInput.get(res) ?? 0);
                  let ms = Number.POSITIVE_INFINITY;
                  if (surplus > 0) ms = Math.max(0, (needed - current) / surplus) * 1000;
                  if (ms > etaMs) etaMs = ms;
               });
            } else {
               // can afford at least +1; find highest common level affordably
               const def = Config.Building[b] as unknown as { max?: number } | undefined;
               const upperBound = def?.max ?? highest + 100;
               const affordable = (tgt: number): boolean => {
                  const acc: PartialTabulate<Material> = {};
                  map.forEach((tile) => {
                     if (tile.building.level >= tgt) return;
                     const c = getTotalBuildingCost({ type: b }, tile.building.level, tgt);
                     keysOf(c).forEach((res) => {
                        acc[res] = (acc[res] ?? 0) + (c[res] ?? 0);
                     });
                  });
                  return haveResources(acc);
               };
               let low = highest + 1;
               let high = upperBound;
               while (low < high) {
                  const mid = Math.ceil((low + high + 1) / 2);
                  if (affordable(mid)) low = mid;
                  else high = mid - 1;
               }
               targetLevel = low;
            }
         }

         // compute aggregated cost to reach targetLevel (always compute so Total Cost is present)
         const costToShow: PartialTabulate<Material> = {};
         map.forEach((tile) => {
            if (tile.building.level >= targetLevel) return;
            const c = getTotalBuildingCost({ type: b }, tile.building.level, targetLevel);
            keysOf(c).forEach((res) => {
               costToShow[res] = (costToShow[res] ?? 0) + (c[res] ?? 0);
            });
         });

         // recompute ETA based on final costToShow if necessary
         keysOf(costToShow).forEach((res) => {
            const needed = costToShow[res] ?? 0;
            const current = Tick.current.resourceAmount.get(res) ?? 0;
            if (current >= needed) return;
            const surplus = (io.theoreticalOutput.get(res) ?? 0) - (io.theoreticalInput.get(res) ?? 0);
            let ms = Number.POSITIVE_INFINITY;
            if (surplus > 0) ms = Math.max(0, (needed - current) / surplus) * 1000;
            if (ms > etaMs) etaMs = ms;
         });

         ready = haveResources(costToShow);

         result.push({ type: b, highestLevel: highest, minLevel, count: map.size, cost: costToShow, etaMs, etaComputedAt: Date.now(), ready, targetLevel, allSame, anyUpgrading });
      });
      result.sort((a, b) => {
         const ta = Config.BuildingTier[a.type] ?? 0;
         const tb = Config.BuildingTier[b.type] ?? 0;
         if (tb !== ta) return tb - ta; // higher tier first
         return Config.Building[a.type].name().localeCompare(Config.Building[b.type].name());
      });
      return result;
   }, [typeMap, io]);

   return (
      <div className="window-body col" style={{ width: "50vw", maxHeight: "80vh", overflow: "auto" }}>
         <header>
            <h3>Building Manager — Highest Levels</h3>
         </header>
         <div className="sep10" />
         <table className="table-view sticky-header">
            <thead>
               <tr>
                  <th>Building</th>
                  <th className="right">Count</th>
                  <th className="right">Total Cost</th>
                  <th className="right">ETA</th>
                  <th className="right">Highest Level</th>
                  <th></th>
               </tr>
            </thead>
            <tbody>
               {rows.map((r, i) => {
                  const tier = Config.BuildingTier[r.type] ?? 0;
                  const prevTier = i > 0 ? Config.BuildingTier[rows[i - 1].type] ?? 0 : null;
                  return (
                     <>
                        {i > 0 && prevTier !== tier ? (
                           <tr key={`sep-${r.type}-${i}`} className="tier-sep">
                              <td colSpan={5}>
                                 <hr />
                              </td>
                           </tr>
                        ) : null}
                                    <tr key={r.type}>
                                       <td>{Config.Building[r.type].name()}</td>
                                       <td className="right">{r.count}</td>
                                       <td className="right">
                                          {keysOf(r.cost).length === 0 ? (
                                             <span style={{ color: "#888" }}>No cost</span>
                                          ) : (
                                             keysOf(r.cost).map((res, idx) => {
                                                const amt = r.cost[res] ?? 0;
                                                const current = Tick.current.resourceAmount.get(res) ?? 0;
                                                const needs = current < amt;
                                                return (
                                                   <span key={String(res)} style={{ color: needs ? "#d9534f" : undefined }}>
                                                      {Config.Material[res].name()} {FormatNumber({ value: amt })}
                                                      {idx < keysOf(r.cost).length - 1 ? ", " : ""}
                                                   </span>
                                                );
                                             })
                                          )}
                                       </td>
                                       <td className="right">
                                          {Number.isFinite(r.etaMs)
                                             ? (() => {
                                                  const elapsed = now - r.etaComputedAt;
                                                  const remaining = Math.max(0, r.etaMs - elapsed);
                                                  return Number.isFinite(remaining) ? formatHMS(remaining, true) : "-";
                                               })()
                                             : "-"}
                                       </td>
                                       <td className="right">{r.highestLevel}</td>
                                       <td className="right">
                                          <button
                                             className="btn primary"
                                             disabled={r.anyUpgrading || !r.ready}
                                             onPointerDown={() => {
                                                const target = r.targetLevel ?? r.highestLevel;
                                                const count = applyToAllBuildings<IBuildingData>(
                                                   r.type,
                                                   (b) => ({ desiredLevel: target }),
                                                   gs,
                                                );
                                                notifyGameStateUpdate();
                                                showToast(
                                                   `Queued ${count} upgrades for ${Config.Building[r.type].name()} to level ${target}`,
                                                );
                                             }}
                                          >
                                             {r.anyUpgrading
                                                ? "Upgrade In Progress"
                                                : !r.allSame
                                                ? `Upgrade ${r.minLevel} → ${r.highestLevel}`
                                                : !r.ready
                                                ? `Upgrade ${r.highestLevel} → ${r.highestLevel + 1}`
                                                : `Upgrade ${r.highestLevel} → ${r.targetLevel}`}
                                          </button>
                                       </td>
                                    </tr>
                     </>
                  );
               })}
            </tbody>
         </table>
         <div className="sep10" />
         <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
               className="btn"
               onPointerDown={() => {
                  hideModal();
               }}
            >
               Close
            </button>
         </div>
      </div>
   );
}

export default BuildingManagerModal;
            
