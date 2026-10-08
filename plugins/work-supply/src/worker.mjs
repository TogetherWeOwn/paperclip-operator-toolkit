import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { createSupplyPlugin } from './plugin.mjs';

const plugin = definePlugin(createSupplyPlugin());
export default plugin;
runWorker(plugin, import.meta.url);
