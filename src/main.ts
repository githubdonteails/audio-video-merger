import path from "node:path";
import fs from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import * as mime from "mime-types";
import { app, ipcMain, dialog, BrowserWindow } from "electron";
import type { IpcMainEvent } from "electron";
import * as remoteMain from "@electron/remote/main";
import type {
  ProcessFilesRequest,
  SingleProcessOptions,
  ProcessResult,
  FileInfo,
} from "./lib/interfaces";
import { getSeconds } from "./lib/helpers";
import debounce from "lodash/debounce";

//Get the paths to the packaged versions of the binaries we want to use
ffmpeg.setFfmpegPath(
  path
    .join(__dirname, "static", "ffmpeg")
    .replace("app.asar", "app.asar.unpacked"),
);
ffmpeg.setFfprobePath(
  path
    .join(__dirname, "static", "ffprobe")
    .replace("app.asar", "app.asar.unpacked"),
);

let mainWindow: BrowserWindow;
let mainWindowReady = false;
let openFiles: FileInfo[] = [];
const gotTheLock = app.requestSingleInstanceLock();
const enableDevTools = !app.isPackaged;

remoteMain.initialize();

const createWindow = (): void => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      devTools: enableDevTools,
    },
  });

  remoteMain.enable(mainWindow.webContents);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  }

  if (enableDevTools) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once("ready-to-show", () => {
    mainWindowReady = true;
    mainWindow.show();

    if (openFiles.length) {
      handleOpenFiles();
    }
  });
};

function getFileInfo(path: string): FileInfo {
  const { size } = fs.statSync(path);
  const type = String(mime.lookup(path));
  const file: FileInfo = { size, path, type };

  return file;
}

/**
 * Create debounced function because when dropping files on an open program
 * they don't come all at once
 */
const debouncedOpenFiles: () => void = debounce(handleOpenFiles, 1000);

app.on("open-file", (event, path: string) => {
  event.preventDefault();

  // Get some file info
  const file: FileInfo = getFileInfo(path);
  openFiles.push(file);

  if (mainWindowReady) {
    if (openFiles.length === 1) {
      mainWindow.webContents.send("merge:waiting");
    }
    debouncedOpenFiles();
  }
});

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Create myWindow, load the rest of the app, etc...
  app.whenReady().then(createWindow);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function handleOpenFiles() {
  if (!mainWindow) {
    return;
  }

  mainWindow.webContents.send("merge:start", openFiles);
  openFiles = [];
}

function processVideo(
  options: SingleProcessOptions,
  totalBytesProcessed: number,
  totalBytes: number,
  event: IpcMainEvent,
) {
  return new Promise((resolve, reject) => {
    let duration: number | false;

    ffmpeg()
      .input(options.video.path)
      .addInput(options.audio.path)
      .outputOptions(["-c:v copy", "-map 0:v:0", "-map 1:a:0"])
      .on("codecData", (data) => {
        duration = data.video_details ? getSeconds(data.duration) : false;
      })
      .on("end", resolve)
      .on("error", (error) => reject(error.message))
      .on("progress", (progress) => {
        const timemark = getSeconds(progress.timemark);
        if (duration && timemark) {
          // Only send progress if we have enough info
          const currentProgress = Math.min(timemark / duration, 1);
          const currentBytesProcessed = currentProgress * options.bytes;
          event.reply(
            "merge:progress",
            (totalBytesProcessed + currentBytesProcessed) / totalBytes,
          );
        }
      })
      .save(options.output);
  });
}

ipcMain.on("merge", async (event, input: ProcessFilesRequest) => {
  const { videoList, audioList } = input;
  let checksFailed = false;

  const processChain: SingleProcessOptions[] = [];
  let yesToAll = false;
  let noToAll = false;

  // Pre-render checks
  for (const audio of audioList) {
    const filename = path.basename(audio.path, path.extname(audio.path));
    if (
      videoList
        .map((video) => path.basename(video.path, path.extname(video.path)))
        .includes(filename)
    ) {
      dialog.showMessageBoxSync(mainWindow, {
        type: "error",
        message: `Trying to convert ${path.basename(audio.path)} but a video with the same name is being used as a source file. Please rename the source video.`,
      });
      event.reply("merge:cancel");
      checksFailed = true;
    }
  }

  if (checksFailed) {
    return;
  }

  // Loop over all videos and audio
  for (const video of videoList) {
    for (const audio of audioList) {
      const dir = path.dirname(audio.path);
      const fileName =
        path.basename(audio.path, path.extname(audio.path)) +
        path.extname(video.path);
      const videoBaseName = path.basename(video.path, path.extname(video.path));

      const output =
        videoList.length > 1
          ? path.join(dir, `${videoBaseName}_${fileName}`)
          : path.join(dir, fileName);

      // Check if file already exists
      if (fs.existsSync(output) && !yesToAll && !noToAll) {
        // Check if trying to write over a file that's used as a source file
        if (path.basename(video.path) === path.basename(output)) {
          // TODO
        }

        const result: number = dialog.showMessageBoxSync(mainWindow, {
          type: "question",
          message: `The file ${path.basename(output)} already exists in the source folder. Overwrite it?`,
          buttons: ["Yes to all", "Yes", "Cancel"],
        });

        switch (result) {
          case 0: // Yes to all
            yesToAll = true;
            break;
          case 1: // Yes (do nothing)
            break;
          case 2: // Cancel
            event.reply("merge:cancel");
            noToAll = true;
            break;
        }
      }

      processChain.push({
        video,
        audio,
        output,
        bytes: audio.size + video.size,
      });
    }
  }

  if (noToAll) {
    return;
  }

  const result: ProcessResult = {
    processed: 0,
    total: input.numVideos,
    errors: [],
  };

  // Gather total bytesize to process for making an estimation on the progress
  const totalBytes: number = processChain.reduce(
    (total, process) => total + process.bytes,
    0,
  );
  let bytesProcessed = 0;

  for (const current of processChain) {
    await processVideo(current, bytesProcessed, totalBytes, event).catch(
      (error) => {
        result.errors.push(error);
      }
    );
    bytesProcessed += current.bytes;
    result.processed++;
    event.reply("merge:progress", bytesProcessed / totalBytes);
  }

  event.reply(result.errors.length ? "merge:error" : "merge:complete", result);
});

ipcMain.on("showDialog", (_, options) => {
  dialog.showMessageBox(mainWindow, options);
});

ipcMain.on("showOpenDialog", (event, options) => {
  const filePaths: string[] | undefined = dialog.showOpenDialogSync(
    mainWindow,
    options,
  );
  if (filePaths) {
    event.reply(
      "showOpenDialog:response",
      filePaths.map((path) => getFileInfo(path)),
    );
  } else {
    event.reply("showOpenDialog:response", []);
  }
});
