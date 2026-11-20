import fs from 'fs';
import { createRequire } from 'module';
import { decodeVectorBuffer } from './loaders/assetLoader.js';
import {
  preprocessVectorData,
  remapPureBlackForeground,
  type VectorTransformOptions,
} from './utils/vectorPreprocessor.js';

const require = createRequire(import.meta.url);

let engine: any = null;

export const realWasmModule = {
  init: async () => {
    if (!engine) {
      const createTermVG = require('./termvg.cjs');
      const module = await createTermVG();
      engine = new module.TermVGEngine();
      engine.init();
    }
  },
  loadContent: (data: string): boolean => {
    if (!engine) return false;
    try {
      const res = engine.load(data);
      if (res !== 0) {
        console.error(`Failed to load content, C++ error code: ${res}`);
        return false;
      }
      return true;
    } catch (e) {
      console.error("Failed to load content:", e);
      return false;
    }
  },
  load: (filePath: string, transformOptions?: VectorTransformOptions): boolean => {
    if (!engine) return false;
    try {
      const { content, format } = decodeVectorBuffer(fs.readFileSync(filePath), filePath);
      const raw = remapPureBlackForeground(content, format);
      const data = transformOptions ? preprocessVectorData(raw, format, transformOptions) : raw;
      return realWasmModule.loadContent(data);
    } catch (e) {
      console.error("Failed to load file:", e);
      return false;
    }
  },
  setSize: (width: number, height: number): void => {
    if (engine) {
      engine.setSize(width, height);
    }
  },
  getDuration: (): number => {
    return engine ? engine.getDuration() : 0;
  },
  getTotalFrames: (): number => {
    return engine ? engine.getTotalFrames() : 0;
  },
  renderToString: (frame: number, renderMode: number, invertDark: boolean): string => {
    if (!engine) return "";
    const val = engine.renderToString(frame, renderMode, invertDark);
    if (!val) return "";
    return val;
  },
  destroy: () => {
    if (engine) {
      try {
        engine.delete(); // Invokes C++ destructor to free memory
        engine = null;
      } catch (e) {
        console.error("Failed to free WASM memory", e);
      }
    }
  }
};
