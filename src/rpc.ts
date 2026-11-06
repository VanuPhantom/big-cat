import { Rpc } from "@opencode/plugin/rpc"

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
} as const

const commitInput = {
  type: "object",
  properties: {
    directory: { type: "string" },
    hash: { type: "string" },
  },
  required: ["directory", "hash"],
  additionalProperties: false,
} as const

export const BigCat = Rpc.define({
  id: "big-cat",
  methods: {
    log: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
        },
        required: ["directory"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          repository: { type: "string" },
          branch: { type: "string" },
          commits: { type: "array", items: commit },
          message: { type: "string" },
        },
        required: ["repository", "branch", "commits", "message"],
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
  },
  events: {},
} as const)
