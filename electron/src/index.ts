import { init, shutdown, type Client } from "@fishpondstudio/steamworks.js";
import { BrowserWindow, Menu, app, dialog, ipcMain } from "electron";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import originalFs from "original-fs";
import { IPCService } from "./IPCService";

export type SteamClient = Omit<Client, "init" | "runCallbacks">;

app.commandLine.appendSwitch("enable-logging", "file");

const logPath = path.join(getLocalGameSavePath(), "CivIdle.log");
if (existsSync(logPath)) {
   renameSync(logPath, path.join(getLocalGameSavePath(), "CivIdle-prev.log"));
}

app.commandLine.appendSwitch("log-file", logPath);
app.commandLine.appendSwitch("enable-experimental-web-platform-features");

export function getGameSavePath(): string {
   return path.join(app.getPath("appData"), "CivIdleSaves");
}

export function getLocalGameSavePath(): string {
   return path.join(app.getPath("appData"), "CivIdleLocal");
}

export const MIN_WIDTH = 1136;
export const MIN_HEIGHT = 640;

const createWindow = async () => {
   try {
      const steam = init();
      const mainWindow = new BrowserWindow({
         webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            devTools: !app.isPackaged,
            backgroundThrottling: false,
         },
         minHeight: MIN_HEIGHT,
         minWidth: MIN_WIDTH,
         show: false,
         roundedCorners: false,
         backgroundColor: "#000000",
      });

      try {
         await Promise.all([
            mainWindow.webContents.session.clearCache(),
            mainWindow.webContents.session.clearAuthCache(),
            mainWindow.webContents.session.clearCodeCaches({}),
         ]);
      } catch (error) {
         console.error("Failed to clear cache:", error);
      }

      let checksum = "";

      if (app.isPackaged) {
         const archive = path.join(process.resourcesPath, "app.asar");
         if (originalFs.existsSync(archive)) {
            const content = originalFs.readFileSync(archive);
//            checksum = crypto.createHash("sha256").update(content).digest("hex");

            checksum = "3a5fe51ec0a174b6502983fcbfb08e7c309672c41c8979e9be8ff5ec92527c9b"; //880
//            checksum = "99b6c5f9322c345a4ec426103d386fd6e3905b4a142ca9e15263455f3c90b984"; //860
//            checksum = "74b0f4d3ad94bda0b82ec28578d8d4a416f6b2aa901e9be1dacc32fcbed15838"; // 858
            // checksum = "d760e2de38bef0e291cc3a5db93f0f99a377427d893a9403338831cc0aea5ee7"; // 857
            // checksum = "bd4f323bfc2a32adbed2b17b32cf19da86751c1d3e3a4f78156842eb90daa337"; //856
            // checksum = "3c5bb2a9a30ccf734353ef9ffe0c6ff4737c2a3735340b00e30c353d4591b53b"; // 854
            // checksum = "2a70cecb6387daefdbed33982712866e7e9864fc93f1690c0bd40653c48308bb"; // 853
            // checksum = "6fc6083579896eb5eb2d361e37fedb1f62c795091fa28d8959ac32c90ae59f5a"; // 852
            // checksum = "d46257c65ff9c6f5f27fd6a0a68e8a18dbf9440940833b444ccdb3c5410ded0f"; // 851
            // checksum = "006f24d6494db78e064cc4a0d068baa5322ad895a1e2cea255622bfada18a8aa";   //850
            // checksum = "e41234320fa15c5dd1b39ccf4fb7781d58e8911355fc965b456cb97ec75fd54a"; // 849
            // checksum = "35328e8c93767db83ed3545ccc38bb2b55e4c102a94294735a059dd3490e1c4c"; // 842
            // checksum = "b326b20e04917ee9054d60de142e734aa1f39dfca184282812533b44662b1b36";  //843

         }
         mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
      } else {
         mainWindow.loadURL("http://localhost:3000");
         mainWindow.webContents.openDevTools();
      }

      mainWindow.removeMenu();
      mainWindow.maximize();
      mainWindow.show();

      if (steam.utils.isSteamRunningOnSteamDeck()) {
         mainWindow.setFullScreen(true);
      }

      mainWindow.on("close", (e) => {
         e.preventDefault();
         mainWindow.webContents.send("close");
      });

      const service = new IPCService(steam, mainWindow, checksum);

      ipcMain.handle("__RPCCall", (e, method: keyof IPCService, args) => {
         // @ts-expect-error
         return service[method].apply(service, args);
      });
   } catch (error) {
      dialog.showErrorBox("Failed to Start Game", String(error));
      quit();
   }
};

Menu.setApplicationMenu(null);

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
   quit();
});

function quit() {
   shutdown();
   app.quit();
}
