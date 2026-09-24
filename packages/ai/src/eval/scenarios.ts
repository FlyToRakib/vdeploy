import type { ReplicaEvidence } from '@vdeploy/contracts';

/**
 * A broken deployment, as the agent would have reported it, with the answer
 * a person deserves. The same set scores two things: the deterministic
 * rules on their own (§32, no model), and the assistant on top of them.
 */
export interface Scenario {
  id: string;
  /** What a person would say happened. */
  title: string;
  /** The question a person actually asks. */
  question: string;
  containerPort: number | null;
  memoryLimit: string;
  evidence: ReplicaEvidence[];
  /** The build log, when the failure is a build (no evidence then). */
  buildLog?: string;
  expect: {
    /** The condition the rules must name. */
    condition: string;
    confidence: 'high' | 'medium';
    /** Every one of these must appear in the answer (case-insensitive). */
    mentions: RegExp[];
    /** The operation the assistant should prepare, or null when there is nothing to change here. */
    fixOperation: string | null;
  };
}

function replica(over: Partial<ReplicaEvidence> = {}): ReplicaEvidence {
  return {
    container: 'vd-blog-1',
    state: 'running',
    exitCode: null,
    oomKilled: false,
    restarts: 0,
    listening: [],
    lastOutput: '',
    ...over,
  };
}

/**
 * Words that describe the symptom rather than the cause (§32 rule 1), and
 * words a non-coder cannot act on. No answer may contain them.
 */
export const BANNED = [
  /health check failed/i,
  /container (?:is )?unhealthy/i,
  /non-zero exit(?: code)?\b/i,
  /check the logs/i,
  /something went wrong/i,
  /stack trace/i,
];

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'wrong-port',
    title: 'The app answers on 3000; traffic goes to 4000',
    question: 'Why is my site down?',
    containerPort: 4000,
    memoryLimit: '512Mi',
    evidence: [replica({ state: 'unhealthy', listening: ['0.0.0.0:3000'] })],
    expect: {
      condition: 'wrong_port',
      confidence: 'high',
      mentions: [/3000/, /4000/],
      fixOperation: 'project.update_spec',
    },
  },
  {
    id: 'localhost-only',
    title: 'The app listens on localhost, so nothing outside can reach it',
    question: 'Why is my site down?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [replica({ state: 'unhealthy', listening: ['127.0.0.1:3000'] })],
    expect: {
      condition: 'listening_on_localhost',
      confidence: 'high',
      mentions: [/0\.0\.0\.0/, /localhost|127\.0\.0\.1/],
      // The fix is in the person's own code, not in a setting VDeploy holds.
      fixOperation: null,
    },
  },
  {
    id: 'out-of-memory',
    title: 'The app is killed for using more memory than it is allowed',
    question: 'My site keeps restarting. What is happening?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [replica({ state: 'exited', exitCode: 137, oomKilled: true, restarts: 4 })],
    expect: {
      condition: 'out_of_memory',
      confidence: 'high',
      mentions: [/memory/i, /512Mi/],
      fixOperation: 'project.update_spec',
    },
  },
  {
    id: 'missing-env-var',
    title: 'The app needs a setting it was never given',
    question: 'Why is my site down?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [
      replica({
        state: 'exited',
        exitCode: 1,
        restarts: 5,
        lastOutput: 'Error: environment variable DATABASE_URL is not set\n    at boot (app.js:12)',
      }),
    ],
    expect: {
      condition: 'missing_env_var',
      confidence: 'high',
      mentions: [/DATABASE_URL/],
      fixOperation: 'env.set',
    },
  },
  {
    id: 'database-unreachable',
    title: 'The app cannot reach its database',
    question: 'Why is my site down?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [
      replica({
        state: 'exited',
        exitCode: 1,
        restarts: 3,
        lastOutput: 'Error: connect ECONNREFUSED 10.0.0.9:5432',
      }),
    ],
    expect: {
      condition: 'database_unreachable',
      confidence: 'high',
      mentions: [/database/i],
      fixOperation: null,
    },
  },
  {
    id: 'module-not-found',
    title: 'An import differs from the file name only in capital letters',
    question: 'It works on my laptop but not here. Why?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [
      replica({
        state: 'exited',
        exitCode: 1,
        restarts: 3,
        lastOutput: "Error: Cannot find module './components/Header'",
      }),
    ],
    expect: {
      condition: 'module_not_found',
      confidence: 'high',
      mentions: [/Header/, /capital|case/i],
      fixOperation: null,
    },
  },
  {
    id: 'port-in-use',
    title: 'Two servers inside one container want the same port',
    question: 'Why is my site down?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [
      replica({
        state: 'exited',
        exitCode: 1,
        restarts: 3,
        lastOutput: 'Error: listen EADDRINUSE: address already in use :::3000',
      }),
    ],
    expect: {
      condition: 'port_in_use',
      confidence: 'high',
      mentions: [/port/i],
      fixOperation: null,
    },
  },
  {
    id: 'runtime-version',
    title: 'The app needs a newer language version than it was built with',
    question: 'Why did my deploy stop working?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [
      replica({
        state: 'exited',
        exitCode: 1,
        restarts: 3,
        lastOutput: 'This package requires Node 22 or later',
      }),
    ],
    expect: {
      condition: 'runtime_version',
      confidence: 'high',
      mentions: [/22|version/i],
      fixOperation: null,
    },
  },
  {
    id: 'unknown-crash',
    title: 'The app crashes for a reason no rule knows',
    question: 'Why is my site down?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [
      replica({
        state: 'exited',
        exitCode: 1,
        restarts: 6,
        lastOutput: 'panic: invalid memory address or nil pointer dereference',
      }),
    ],
    expect: {
      condition: 'crash_loop',
      confidence: 'medium',
      mentions: [/nil pointer|stops|stopping/i],
      // Nothing is sure enough to change: the answer offers to look, not to fix.
      fixOperation: null,
    },
  },
  {
    id: 'not-listening',
    title: 'The app runs but nothing answers on its port',
    question: 'Why is my site down?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [replica({ state: 'unhealthy', listening: [] })],
    expect: {
      condition: 'not_listening',
      confidence: 'medium',
      mentions: [/3000/],
      fixOperation: null,
    },
  },
  {
    id: 'build-missing-script',
    title: 'The build asks for a script the app does not have',
    question: 'Why did my deploy fail?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [],
    buildLog: 'npm ERR! Missing script: "build"\nnpm ERR! A complete log of this run can be found',
    expect: {
      condition: 'build_missing_script',
      confidence: 'high',
      mentions: [/script/i],
      fixOperation: null,
    },
  },
  {
    id: 'build-out-of-memory',
    title: 'The build itself runs out of memory',
    question: 'Why did my deploy fail?',
    containerPort: 3000,
    memoryLimit: '512Mi',
    evidence: [],
    buildLog: 'FATAL ERROR: JavaScript heap out of memory\nAborted (core dumped)',
    expect: {
      condition: 'build_out_of_memory',
      confidence: 'high',
      mentions: [/memory/i],
      fixOperation: null,
    },
  },
];
