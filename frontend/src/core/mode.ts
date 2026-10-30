// Which world this page runs on. `make dev-mock` (and the tests) use the simulator with its fake companies;
// everything else talks to the backend.
export const MOCK = import.meta.env.MODE === 'mock' || import.meta.env.MODE === 'test'
