import { config } from "@vue/test-utils";
import { i18n } from "../i18n";

// Install i18n globally for all component mounts. Default locale is "en", so
// existing assertions on English text keep passing unchanged.
config.global.plugins.push(i18n);
