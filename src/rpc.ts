import { Rpc } from "@opencode/plugin/rpc";

const commit = {
  type: "object",
  properties: {
    hash: { type: "string" },
    author: { type: "string" },
    date: { type: "string" },
    subject: { type: "string" },
  },
  required: ["hash", "author", "date", "subject"],
  additionalProperties: false,
} as const;

const directoryInput = {
  type: "object",
  properties: {
    directory: { type: "string" },
  },
  required: ["directory"],
  additionalProperties: false,
} as const;

const commitInput = {
  type: "object",
  properties: {
    directory: { type: "string" },
    hash: { type: "string" },
  },
  required: ["directory", "hash"],
  additionalProperties: false,
} as const;

export const BigCat = Rpc.define({
  id: "big-cat",
  methods: {
    log: {
      input: directoryInput,
      output: {
        type: "object",
        properties: {
          repository: { type: "string" },
          branch: { type: "string" },
          commits: { type: "array", items: commit },
          hasStagedChanges: { type: "boolean" },
          hasUnstagedChanges: { type: "boolean" },
          message: { type: "string" },
        },
        required: [
          "repository",
          "branch",
          "commits",
          "hasStagedChanges",
          "hasUnstagedChanges",
          "message",
        ],
        additionalProperties: false,
      },
    },
    details: {
      input: commitInput,
      output: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
    diff: {
      input: commitInput,
      output: {
        type: "object",
        properties: {
          diff: { type: "string" },
        },
        required: ["diff"],
        additionalProperties: false,
      },
    },
    workingDiff: {
      input: {
        type: "object",
        properties: {
          ...directoryInput.properties,
          staged: { type: "boolean" },
        },
        required: ["directory", "staged"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          diff: { type: "string" },
        },
        required: ["diff"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const);
