import classNames from "classnames";
import type { PropsWithChildren } from "react";
import { useEffect, useRef, useState } from "react";
import { isChristmas, isHalloween } from "../../../shared/definitions/TimedBuildingUnlock";
import { DISCORD_URL, SUPPORTER_PACK_URL } from "../../../shared/logic/Constants";
import { getGameOptions, notifyGameOptionsUpdate, watchGameOptions } from "../../../shared/logic/GameStateLogic";
import { Tick } from "../../../shared/logic/TickLogic";
import { isSaveOwner } from "../../../shared/utilities/DatabaseShared";
import { isNullOrUndefined, sizeOf } from "../../../shared/utilities/Helper";
import { L, t } from "../../../shared/utilities/i18n";
import Bat from "../../images/Bat.svg";
import SpiderWeb from "../../images/SpiderWeb.svg";
import Xmas1 from "../../images/Xmas1.png";
import Xmas2 from "../../images/Xmas2.png";
import Xmas3 from "../../images/Xmas3.png";
import Xmas4 from "../../images/Xmas4.png";
import Xmas5 from "../../images/Xmas5.png";
import Xmas6 from "../../images/Xmas6.png";
import Xmas7 from "../../images/Xmas7.png";
import Xmas8 from "../../images/Xmas8.png";
import { compressSave, saveGame, useFloatingMode } from "../Global";
import { client, usePlatformInfo, useUser } from "../rpc/RPCClient";
import { SteamClient, isSteam } from "../rpc/SteamClient";
import { getOwnedTradeTile } from "../scenes/PathFinder";
import { PlayerMapScene } from "../scenes/PlayerMapScene";
import { TechTreeScene } from "../scenes/TechTreeScene";
import { WorldScene } from "../scenes/WorldScene";
import { openUrl } from "../utilities/Platform";
import { Singleton } from "../utilities/Singleton";
import { playClick, playError } from "../visuals/Sound";
import { AboutModal } from "./AboutModal";
import { GameplayOptionPage } from "./GameplayOptionPage";
import { showModal, showToast } from "./GlobalModal";
import { ManageAgeWisdomModal } from "./ManageAgeWisdomModal";
import { ManagePermanentGreatPersonModal } from "./ManagePermanentGreatPersonModal";
import { ManualAndGuidePage } from "./ManualAndGuidePage";
import { PatchNotesPage } from "./PatchNotesPage";
import { PlayerTradeModal } from "./PlayerTradeModal";
import { RebirthModal } from "./RebirthModal";
import { ShortcutPage } from "./ShortcutPage";
import { ThemePage } from "./ThemePage";

type MenuItemOptions = "view" | "options" | "help" | "scripts" | null;

function MenuButton({ name }: { name: string }): React.ReactNode {
   return (
      <>
         <span className="menu-hotkey">{name.substring(0, 1)}</span>
         {name.substring(1)}
      </>
   );
}

function MenuItem({ check, children }: PropsWithChildren<{ check: boolean }>): React.ReactNode {
   return (
      <>
         <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            xmlns="http://www.w3.org/2000/svg"
            style={{
               fill: "currentcolor",
               display: "inline-block",
               verticalAlign: "middle",
               visibility: check ? "visible" : "hidden",
               marginRight: "2px",
               marginLeft: "2px",
            }}
         >
            <path d="M5 7v3l2 2 5-5V4L7 9Z"></path>
         </svg>
         {children}
      </>
   );
}

const XmasImages = [Xmas1, Xmas2, Xmas3, Xmas4, Xmas5, Xmas6, Xmas7, Xmas8];
const XmasImage = XmasImages[Math.floor(Math.random() * XmasImages.length)];

export function MenuComponent(): React.ReactNode {
   const [gameOptions, setGameOptions] = useState(() => getGameOptions());
   useEffect(() => {
      const unsub = watchGameOptions((opts) => setGameOptions(opts));
      return () => unsub();
   }, []);
   const [active, setActive] = useState<MenuItemOptions>(null);
   const buttonRef = useRef(null);
   const user = useUser();
   const platformInfo = usePlatformInfo();
   const isFloating = useFloatingMode();
   useEffect(() => {
      function onPointerDown(e: PointerEvent) {
         setActive(null);
      }
      window.addEventListener("pointerdown", onPointerDown);
      return () => {
         window.removeEventListener("pointerdown", onPointerDown);
      };
   }, []);
   const now = new Date();
   return (
      <>
         <div className="menus">
            <div
               ref={buttonRef}
               className={classNames({
                  "menu-button": true,
                  active: active === "view",
               })}
               onPointerDown={(e) => {
                  e.nativeEvent.stopPropagation();
                  active === "view" ? setActive(null) : setActive("view");
               }}
               onPointerOver={(e) => {
                  if (active !== null && active !== "view") {
                     setActive("view");
                  }
               }}
            >
               <MenuButton name={t(L.ViewMenu)} />
               <div
                  className={classNames({
                     "menu-popover": true,
                     active: active === "view",
                  })}
               >
                  <div
                     className="menu-popover-item"
                     onPointerDown={(e) => {
                        Singleton().sceneManager.loadScene(WorldScene);
                        setActive(null);
                     }}
                  >
                     <MenuItem check={Singleton().sceneManager.isCurrent(WorldScene)}>
                        {t(L.CityViewMap)}
                     </MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={(e) => {
                        Singleton().sceneManager.loadScene(TechTreeScene);
                        setActive(null);
                     }}
                  >
                     <MenuItem check={Singleton().sceneManager.isCurrent(TechTreeScene)}>
                        {t(L.ResearchMenu)}
                     </MenuItem>
                  </div>
                  {sizeOf(Tick.current.playerTradeBuildings) <= 0 ? null : (
                     <div
                        className="menu-popover-item"
                        onPointerDown={(e) => {
                           Singleton().sceneManager.loadScene(PlayerMapScene);
                           setActive(null);
                        }}
                     >
                        <MenuItem check={Singleton().sceneManager.isCurrent(PlayerMapScene)}>
                           {t(L.PlayerMapMenuV2)}
                        </MenuItem>
                     </div>
                  )}
                  {getOwnedTradeTile() && Tick.current.playerTradeBuildings.size > 0 ? (
                     <div
                        className="menu-popover-item"
                        onPointerDown={(e) => {
                           showModal(<PlayerTradeModal />);
                           setActive(null);
                        }}
                     >
                        <MenuItem check={Singleton().sceneManager.isCurrent(PlayerMapScene)}>
                           {t(L.PlayerTradeMenu)}
                        </MenuItem>
                     </div>
                  ) : null}
                  <div
                     className="menu-popover-item"
                     onPointerDown={(e) => {
                        showModal(<RebirthModal />);
                        setActive(null);
                     }}
                  >
                     <MenuItem check={false}>{t(L.Reborn)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={(e) => {
                        showModal(<ManagePermanentGreatPersonModal />);
                        setActive(null);
                     }}
                  >
                     <MenuItem check={false}>{t(L.GreatPeople)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={(e) => {
                        showModal(<ManageAgeWisdomModal />);
                        setActive(null);
                     }}
                  >
                     <MenuItem check={false}>{t(L.AgeWisdom)}</MenuItem>
                  </div>
               </div>
            </div>
            <div
               ref={buttonRef}
               className={classNames({
                  "menu-button": true,
                  active: active === "options",
               })}
               onPointerDown={(e) => {
                  e.nativeEvent.stopPropagation();
                  active === "options" ? setActive(null) : setActive("options");
               }}
               onPointerOver={(e) => {
                  if (active !== null && active !== "options") {
                     setActive("options");
                  }
               }}
            >
               <MenuButton name={t(L.OptionsMenu)} />
               <div
                  className={classNames({
                     "menu-popover": true,
                     active: active === "options",
                  })}
               >
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        Singleton().routeTo(GameplayOptionPage, {});
                     }}
                  >
                     <MenuItem check={false}>{t(L.Gameplay)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        Singleton().routeTo(ThemePage, {});
                     }}
                  >
                     <MenuItem check={false}>{t(L.Theme)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        Singleton().routeTo(ShortcutPage, {});
                     }}
                  >
                     <MenuItem check={false}>{t(L.Shortcut)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        try {
                           await saveGame();
                           window.location.search = "?scene=Save";
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={false}>{t(L.ManageSave)}</MenuItem>
                  </div>
               </div>
            </div>
            <div
               ref={buttonRef}
               className={classNames({
                  "menu-button": true,
                  active: active === "help",
               })}
               onPointerDown={(e) => {
                  e.nativeEvent.stopPropagation();
                  active === "help" ? setActive(null) : setActive("help");
               }}
               onPointerOver={(e) => {
                  if (active !== null && active !== "help") {
                     setActive("help");
                  }
               }}
            >
               <MenuButton name={t(L.HelpMenu)}></MenuButton>
               <div
                  className={classNames({
                     "menu-popover": true,
                     active: active === "help",
                  })}
               >
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        Singleton().routeTo(PatchNotesPage, {});
                     }}
                  >
                     <MenuItem check={false}>{t(L.PatchNotes)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        Singleton().routeTo(ManualAndGuidePage, {});
                     }}
                  >
                     <MenuItem check={false}>{t(L.ManualAndGuide)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        openUrl(DISCORD_URL);
                     }}
                  >
                     <MenuItem check={false}>{t(L.JoinDiscord)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        const userId = user?.userId ?? "Unknown Id";
                        const tag = `(${user?.handle ?? "Unknown Handle"}/${userId})`;
                        const subject = `CivIdle In-Game Message ${tag}`;
                        const body = [
                           "Please provide as much details as possible (step-by-step reproductions, screenshots, screen recording, etc)\n",
                           "----- Keep the following tag for identification -----",
                           tag,
                        ];
                        openUrl(
                           `mailto:hi@fishpondstudio.com?subject=${encodeURIComponent(
                              subject,
                           )}&body=${encodeURIComponent(body.join("\n"))}`,
                        );
                     }}
                  >
                     <MenuItem check={false}>{t(L.EmailDeveloper)}</MenuItem>
                  </div>
                  {isSteam() ? (
                     <div
                        className="menu-popover-item"
                        onPointerDown={() => {
                           saveGame()
                              .then(() => SteamClient.quit())
                              .catch((e) => {
                                 playError();
                                 showToast(String(e));
                              });
                        }}
                     >
                        <MenuItem check={false}>{t(L.SaveAndExit)}</MenuItem>
                     </div>
                  ) : null}
                  {isSteam() &&
                  user &&
                  !isNullOrUndefined(platformInfo?.connectedUserId) &&
                  isSaveOwner(platformInfo, user) ? (
                     <div
                        className="menu-popover-item"
                        onPointerDown={async () => {
                           try {
                              await saveGame();
                              await client.checkInSave(await compressSave());
                              SteamClient.quit();
                           } catch (error) {
                              playError();
                              showToast(String(error));
                           }
                        }}
                     >
                        <MenuItem check={false}>{t(L.CheckInAndExit)}</MenuItem>
                     </div>
                  ) : null}
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        playClick();
                        openUrl(SUPPORTER_PACK_URL);
                     }}
                  >
                     <MenuItem check={false}>{t(L.SupporterPack)}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={() => {
                        showModal(<AboutModal />);
                     }}
                  >
                     <MenuItem check={false}>{t(L.About)}</MenuItem>
                  </div>
               </div>
            </div>
            <div
               ref={buttonRef}
               className={classNames({
                  "menu-button": true,
                  active: active === "scripts",
               })}
               onPointerDown={(e) => {
                  e.nativeEvent.stopPropagation();
                  active === "scripts" ? setActive(null) : setActive("scripts");
               }}
               onPointerOver={(e) => {
                  if (active !== null && active !== "scripts") {
                     setActive("scripts");
                  }
               }}
            >
               <MenuButton name={"Dave's Scripts"} />
               <div
                  className={classNames({
                     "menu-popover": true,
                     active: active === "scripts",
                  })}
               >
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           // dynamic import so UI doesn't depend on the scripts module at compile time
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.buildInitialMines === "function") {
                              const result = mod.buildInitialMines();
                              const houses = result.houseResult?.placed ?? 0;
                              // mark as run for this rebirth
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.BuildInitialMines = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              showToast(
                                 `BuildInitialMines: Houses ${houses}, Aqueducts ${result.aqueductPlaced}, Quarries ${result.stoneQuarryPlaced}, Logging ${result.loggingCampPlaced}`,
                              );
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.BuildInitialMines ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"001 - Build Initial Mines"}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.buildApartments === "function") {
                                 const res = await mod.buildApartments();
                                 const matsOk = res.materials ? 'ok' : 'none';
                                 const supportOk = res.support ? 'ok' : 'none';
                                 const deploySummary = res.deploy ? `placed ${res.deploy.placed}/${res.deploy.requested}` : 'not run';
                                 // mark as run for this rebirth
                                 const opts = getGameOptions();
                                 opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                                 opts.daveScriptsRun.BuildApartments = opts.rebirthInfo?.length ?? 0;
                                 notifyGameOptionsUpdate(opts);
                                 // Present a compact summary in the toast
                                 showToast(`BuildApartments: Materials ${matsOk}, Support ${supportOk}, Deploy ${deploySummary}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.BuildApartments ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"002 - Build Apartments"}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.buildBigBenMaterials === "function") {
                              const res = mod.buildBigBenMaterials();
                              if (!res.results) {
                                 showToast(`BuildBigBenMaterials: ${res.message ?? 'no tiles placed'}`);
                                 return;
                              }
                              // mark as run for this rebirth
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.BuildBigBenMaterials = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              const summary = res.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
                              showToast(`BuildBigBenMaterials: ${summary}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.BuildBigBenMaterials ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"003 - Build Big Ben Materials"}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.prepareCondoMaterials === "function") {
                              const res = mod.prepareCondoMaterials();
                              // mark as run for this rebirth
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.PrepareCondoMaterials = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              const top = res.topPlacement ? res.topPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              const bottom = res.bottomPlacement ? res.bottomPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              showToast(`PrepareCondoMaterials: top: ${top}; cleared ${res.cleared?.cleared ?? 0}; bottom: ${bottom}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.PrepareCondoMaterials ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"004 - Prepare Condo Materials"}</MenuItem>
                  </div>
                  {/* 004 was removed to keep the list contiguous */}
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.replaceApartmentsWithCondos === "function") {
                              const res = await mod.replaceApartmentsWithCondos();
                              // mark as run for this rebirth
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.ReplaceApartmentsWithCondos = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              showToast(
                                 `ReplaceApartmentsWithCondos: removed ${res.removedApartments}, placed ${res.placed}/${res.requested}`,
                              );
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.ReplaceApartmentsWithCondos ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"005 - Replace Apartments with Condos"}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.prepareCnTowerMaterials === "function") {
                              const res = mod.prepareCnTowerMaterials();
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.PrepareCnTowerMaterial = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              const top = res.nonElectPlacement ? res.nonElectPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              const bottom = res.electPlacement ? res.electPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              showToast(`PrepareCN: cleared ${res.cleared?.cleared ?? 0}; non-elect: ${top}; elect: ${bottom}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.PrepareCnTowerMaterial ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"006 - Prepare CN Tower Material"}</MenuItem>
                  </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.prepareAtomiumAndOxUni === "function") {
                              const res = mod.prepareAtomiumAndOxUni();
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.PrepareAtomiumAndOxUni = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              const non = res.nonElectPlacement ? res.nonElectPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              const elect = res.electPlacement ? res.electPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              showToast(`PrepareAtomiumAndOxUni: clearedTop ${res.clearedTop?.cleared ?? 0}; clearedBottom ${res.clearedBottom?.cleared ?? 0}; non-elect: ${non}; elect: ${elect}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.PrepareAtomiumAndOxUni ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"007 - Prepare Atomium and Ox Uni"}</MenuItem>
                  </div>
                    <div
                       className="menu-popover-item"
                       onPointerDown={async () => {
                          playClick();
                          setActive(null);
                          try {
                             const mod = await import("../logic/davescripts");
                             if (mod && typeof mod.prepareCloneLabs === "function") {
                                const res = mod.prepareCloneLabs();
                                const opts = getGameOptions();
                                opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                                opts.daveScriptsRun.PrepareCloneLabs = opts.rebirthInfo?.length ?? 0;
                                notifyGameOptionsUpdate(opts);
                                const non = res.nonElectPlacement ? res.nonElectPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                                const elect = res.electPlacement ? res.electPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                                showToast(`PrepareCloneLabs: clearedTop ${res.clearedTop?.cleared ?? 0}; clearedBottom ${res.clearedBottom?.cleared ?? 0}; non-elect: ${non}; elect: ${elect}`);
                             } else {
                                showToast("Dave's scripts are not available in this build.");
                             }
                          } catch (err) {
                             playError();
                             showToast(String(err));
                          }
                       }}
                    >
                       <MenuItem check={((gameOptions.daveScriptsRun?.PrepareCloneLabs ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"008 - Prepare Clone Labs"}</MenuItem>
                    </div>
                   <div
                      className="menu-popover-item"
                      onPointerDown={async () => {
                         playClick();
                         setActive(null);
                         try {
                            const mod = await import("../logic/davescripts");
                            if (mod && typeof mod.buildCloneLabs === "function") {
                               const res = await mod.buildCloneLabs();
                               const opts = getGameOptions();
                               opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                               opts.daveScriptsRun.BuildCloneLabs = opts.rebirthInfo?.length ?? 0;
                               notifyGameOptionsUpdate(opts);
                               showToast(`BuildCloneLabs: removedCondos ${res.removedCondos}; placed ${res.placed}/${res.requested}; remaining ${res.remaining}`);
                            } else {
                               showToast("Dave's scripts are not available in this build.");
                            }
                         } catch (err) {
                            playError();
                            showToast(String(err));
                         }
                      }}
                   >
                      <MenuItem check={((gameOptions.daveScriptsRun?.BuildCloneLabs ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"009 - Build Clone Labs"}</MenuItem>
                   </div>
                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.dysonBuildPlan1 === "function") {
                              const res = await mod.dysonBuildPlan1();
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.DysonPart1 = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              const smallSummary = res.smallRowPlacement ? res.smallRowPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              showToast(`Dyson Part 1 complete: removedCloneLabs ${res.removedCloneLabs}; cleared ${res.cleared?.cleared ?? 0}; smallRow: ${smallSummary}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.DysonPart1 ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"Dyson Part 1"}</MenuItem>
                  </div>

                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.dysonBuildPlan2 === "function") {
                              const res = await mod.dysonBuildPlan2();
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.DysonPart2 = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              const summary = res.placement ? res.placement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              showToast(`Dyson Part 2 complete: placed ${res.placement ? res.placement.results.reduce((a,b)=>a+(b.placed||0),0):0}; ${summary}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.DysonPart2 ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"Dyson Part 2"}</MenuItem>
                  </div>

                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.dysonBuildPlan3 === "function") {
                              const res = await mod.dysonBuildPlan3();
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.DysonPart3 = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              const summary = res.placement ? res.placement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") : "none";
                              showToast(`Dyson Part 3 complete: placed ${res.placement ? res.placement.results.reduce((a,b)=>a+(b.placed||0),0):0}; ${summary}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.DysonPart3 ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"Dyson Part 3"}</MenuItem>
                  </div>

                  <div
                     className="menu-popover-item"
                     onPointerDown={async () => {
                        playClick();
                        setActive(null);
                        try {
                           const mod = await import("../logic/davescripts");
                           if (mod && typeof mod.dysonBuildPlan4 === "function") {
                              const res = await mod.dysonBuildPlan4();
                              const opts = getGameOptions();
                              opts.daveScriptsRun = opts.daveScriptsRun ?? {};
                              opts.daveScriptsRun.DysonPart4 = opts.rebirthInfo?.length ?? 0;
                              notifyGameOptionsUpdate(opts);
                              const summary = (res.leftStripPlacement || []).map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ") || "none";
                              showToast(`Dyson Part 4 complete: ${summary}`);
                           } else {
                              showToast("Dave's scripts are not available in this build.");
                           }
                        } catch (err) {
                           playError();
                           showToast(String(err));
                        }
                     }}
                  >
                     <MenuItem check={((gameOptions.daveScriptsRun?.DysonPart4 ?? -1) === (gameOptions.rebirthInfo?.length ?? 0))}>{"Dyson Part 4"}</MenuItem>
                  </div>
               </div>
            </div>
            {isHalloween(now) ? (
               <img
                  src={SpiderWeb}
                  style={{
                     position: "absolute",
                     top: -25,
                     right: 50,
                     zIndex: 1,
                     pointerEvents: "none",
                     width: 80,
                  }}
               />
            ) : null}
            {isHalloween(now) ? (
               <img
                  src={Bat}
                  style={{
                     position: "absolute",
                     top: -20,
                     right: 200,
                     zIndex: 1,
                     pointerEvents: "none",
                  }}
               />
            ) : null}
            {isChristmas(now) ? (
               <img
                  src={XmasImage}
                  style={{
                     position: "absolute",
                     top: -20,
                     right: 80,
                     zIndex: 1,
                     pointerEvents: "none",
                     height: 50,
                  }}
               />
            ) : null}
         </div>
         <div className="separator"></div>
      </>
   );
}
