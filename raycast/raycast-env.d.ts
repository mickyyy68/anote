/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Bridge Binary Path - Absolute path to anote_bridge executable */
  "bridgeBinaryPath"?: string,
  /** Bridge Repo Root - Path to the anote repository root (containing src-tauri) */
  "bridgeRepoRoot"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-notes` command */
  export type SearchNotes = ExtensionPreferences & {}
  /** Preferences accessible in the `create-note` command */
  export type CreateNote = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `search-notes` command */
  export type SearchNotes = {}
  /** Arguments passed to the `create-note` command */
  export type CreateNote = {}
}

