import { useMemo } from "react";
import type { Building } from "../../../shared/definitions/BuildingDefinitions";
import type { Material } from "../../../shared/definitions/MaterialDefinitions";
import {
    applyToAllBuildings,
    getTotalBuildingCost,
    IOFlags,
    isBuildingUpgradable,
} from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import { notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { getBuildingIO, getResourceIO, getTypeBuildings } from "../../../shared/logic/IntraTickCache";
import { Tick } from "../../../shared/logic/TickLogic";
import type { IBuildingData } from "../../../shared/logic/Tile";
import { forEach, formatHMS, keysOf } from "../../../shared/utilities/Helper";
import type { PartialTabulate } from "../../../shared/utilities/TypeDefinitions";
import { useGameState } from "../Global";
import { hideModal, showToast } from "./GlobalModal";
import { FormatNumber } from "./HelperComponents";

export function BuildingManagerModal(): React.ReactNode {
   const gs = useGameState();

   const typeMap = getTypeBuildings(gs);
   const io = getResourceIO(gs);

   const rows = useMemo(() => {
      const result: Array<{
         type: Building;
         count: number;
         cost: PartialTabulate<Material>;
         ready: boolean;
         etaMs: number;
         evSum: number;
         anyUpgrading: boolean;
      }> = [];

      typeMap.forEach((map, b) => {
         if (!map || map.size <= 0) return;
         if (!isBuildingUpgradable(b)) return;

         const totalCost: PartialTabulate<Material> = {};
         map.forEach((tile) => {
            const c = getTotalBuildingCost({ type: b }, tile.building.level, tile.building.level + 1);
            forEach(c, (res, amt) => {
               totalCost[res] = (totalCost[res] ?? 0) + amt;
            });
         });

         let maxMs = 0;
         let ready = true;
         keysOf(totalCost).forEach((res) => {
            const needed = totalCost[res] ?? 0;
            const current = Tick.current.resourceAmount.get(res) ?? 0;
            if (current < needed) ready = false;
            const surplus = (io.theoreticalOutput.get(res) ?? 0) - (io.theoreticalInput.get(res) ?? 0);
            let ms = Number.POSITIVE_INFINITY;
            if (current >= needed) {
               ms = 0;
            } else if (surplus > 0) {
               ms = Math.max(0, (needed - current) / surplus) * 1000;
            } else {
               ms = Number.POSITIVE_INFINITY;
            }
            if (ms > maxMs) maxMs = ms;
         });

         let evSumForType = 0;
         let anyUpgrading = false;
         map.forEach((tile, xy) => {
            const outputIO = getBuildingIO(xy, "output", IOFlags.Multiplier | IOFlags.Capacity, gs);
            const inputIO = getBuildingIO(xy, "input", IOFlags.Multiplier | IOFlags.Capacity, gs);
            let outEV = 0;
            let inEV = 0;
            keysOf(outputIO).forEach((res) => {
               const amt = outputIO[res] ?? 0;
               const price = Config.MaterialPrice[res as Material] ?? 0;
               outEV += amt * price;
            });
            keysOf(inputIO).forEach((res) => {
               const amt = inputIO[res] ?? 0;
               const price = Config.MaterialPrice[res as Material] ?? 0;
               inEV += amt * price;
            });
            evSumForType += outEV - inEV;
            const status = tile.building?.status;
            if (status === "upgrading" || status === "building") anyUpgrading = true;
         });

         result.push({ type: b, count: map.size, cost: totalCost, ready, etaMs: maxMs, evSum: evSumForType, anyUpgrading });
      });

      // Sort by building tier (highest first), then EV desc, then name
      result.sort((a, b) => {
         const ta = Config.BuildingTier[a.type] ?? 0;
         const tb = Config.BuildingTier[b.type] ?? 0;
         if (tb !== ta) return tb - ta; // higher tier first
         if (b.evSum !== a.evSum) return b.evSum - a.evSum;
         return Config.Building[a.type].name().localeCompare(Config.Building[b.type].name());
      });
      return result;
   }, [typeMap, io, gs]);

   return (
      <div className="window-body col" style={{ width: "50vw", maxHeight: "80vh", overflow: "auto" }}>
         <header>
            <h3>Building Manager</h3>
         </header>
         <div className="sep10" />
         <table className="table-view sticky-header">
            <thead>
               <tr>
                  <th>{"Building"}</th>
                  <th className="right">{"Count"}</th>
                  <th className="right">{"Total Cost"}</th>
                  <th className="right">{"ETA"}</th>
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
                           "-"
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
                     <td className="right">{Number.isFinite(r.etaMs) ? formatHMS(r.etaMs, true) : "-"}</td>
                     <td className="right">
                        <button
                           className="btn primary"
                           disabled={r.anyUpgrading}
                           onPointerDown={() => {
                              const count = applyToAllBuildings<IBuildingData>(r.type, (b) => ({ desiredLevel: b.level + 1 }), gs);
                              notifyGameStateUpdate();
                              showToast(`Queued ${count} upgrades for ${Config.Building[r.type].name()}`);
                           }}
                        >
                           {r.anyUpgrading ? "Upgrade In Progress" : "Upgrade Now"}
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
