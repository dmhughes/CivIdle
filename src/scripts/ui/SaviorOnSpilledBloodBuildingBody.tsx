import { useState } from "react";
import { saviorOnSpilledBloodProductionMultiplier } from "../../../shared/logic/BuildingLogic";
<<<<<<< HEAD
import type { ISaviorOnSpilledBloodBuildingData } from "../../../shared/logic/Tile";
=======
import type { IAuroraBorealisBuildingData } from "../../../shared/logic/Tile";
>>>>>>> 66bec29d (1.1 (#562))
import { cls, formatHMS, range, SECOND } from "../../../shared/utilities/Helper";
import { L, t } from "../../../shared/utilities/i18n";
import { BuildingColorComponent } from "./BuildingColorComponent";
import { BuildingDescriptionComponent } from "./BuildingDescriptionComponent";
import type { IBuildingComponentProps } from "./BuildingPage";
import { BuildingValueComponent } from "./BuildingValueComponent";
import { BuildingWikipediaComponent } from "./BuildingWikipediaComponent";

export function SaviorOnSpilledBloodBuildingBody({
   gameState,
   xy,
}: IBuildingComponentProps): React.ReactNode {
   const building = gameState.tiles.get(xy)?.building;
   if (!building) {
      return null;
   }
<<<<<<< HEAD
   const saviorOnSpilledBlood = building as ISaviorOnSpilledBloodBuildingData;
   const constructedHours = Math.floor((gameState.tick - saviorOnSpilledBlood.constructedTick) / 3600);
=======
   const saviorOnSpilledBlood = building as IAuroraBorealisBuildingData;
   const constructedHours = Math.floor((gameState.tick - saviorOnSpilledBlood.startTick) / 3600);
>>>>>>> 66bec29d (1.1 (#562))
   const [hours, setHours] = useState(11);
   return (
      <div className="window-body">
         <ul className="tree-view">
            <li className="row">
               <div className="f1">{t(L.ConstructedTime)}</div>
               <div className="text-strong">
<<<<<<< HEAD
                  {formatHMS((gameState.tick - saviorOnSpilledBlood.constructedTick) * SECOND)}
=======
                  {formatHMS((gameState.tick - saviorOnSpilledBlood.startTick) * SECOND)}
>>>>>>> 66bec29d (1.1 (#562))
               </div>
            </li>
            <li className="row">
               <div className="f1">{t(L.ProductionMultiplier)}</div>
               <div className="text-strong">{saviorOnSpilledBloodProductionMultiplier(constructedHours)}</div>
            </li>
         </ul>
         <div className="sep10" />
         <div className="table-view">
            <table>
               <thead>
                  <tr>
                     <th>{t(L.ConstructedTimeHours)}</th>
                     <th className="right">{t(L.ProductionMultiplier)}</th>
                  </tr>
               </thead>
               <tbody>
                  {range(constructedHours, constructedHours + hours).map((hour, index) => {
                     return (
                        <tr className={cls(index === 0 ? "text-strong" : null)} key={hour}>
                           <td>{hour}h</td>
                           <td className="right">{saviorOnSpilledBloodProductionMultiplier(hour)}</td>
                        </tr>
                     );
                  })}
                  <tr>
                     <td className="text-link text-strong" colSpan={2} onClick={() => setHours(hours + 10)}>
                        Show More...
                     </td>
                  </tr>
               </tbody>
            </table>
         </div>
         <div className="sep10" />
         <BuildingDescriptionComponent gameState={gameState} xy={xy} />
         <BuildingValueComponent gameState={gameState} xy={xy} />
         <BuildingWikipediaComponent gameState={gameState} xy={xy} />
         <BuildingColorComponent gameState={gameState} xy={xy} />
      </div>
   );
}
