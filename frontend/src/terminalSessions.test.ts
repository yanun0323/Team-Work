import { expect, it } from 'vitest'
import { terminalPath } from './terminalSessions'

it("asks for a company's shell in its folder, and the airport's at home", () => {
  expect(terminalPath('t1')).toBe('/api/v1/teams/t1/terminal')
  expect(terminalPath('')).toBe('/api/v1/airport/terminal')
})
