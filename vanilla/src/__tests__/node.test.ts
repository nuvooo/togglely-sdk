/**
 * @jest-environment node
 */
const mockDestroy = jest.fn()

jest.mock('@togglely/sdk-core', () => ({
  TogglelyClient: jest.fn().mockImplementation(() => ({
    isEnabled: jest.fn().mockResolvedValue(true),
    destroy: mockDestroy,
  })),
}))

import {
  destroyTogglely,
  getGlobalTogglely,
  initTogglely,
  isEnabled,
} from '../index'

describe('Vanilla SDK in Node (no window)', () => {
  const config = {
    apiKey: 'test-key',
    project: 'test-project',
    environment: 'development',
    baseUrl: 'https://test.togglely.io',
  }

  afterEach(() => {
    destroyTogglely()
    jest.clearAllMocks()
  })

  it('keeps the instance at module level', async () => {
    const client = initTogglely(config)
    expect(getGlobalTogglely()).toBe(client)
    await expect(isEnabled('feature')).resolves.toBe(true)
  })

  it('destroyTogglely() destroys the module-level instance', () => {
    initTogglely(config)
    destroyTogglely()
    expect(mockDestroy).toHaveBeenCalledTimes(1)
    expect(getGlobalTogglely()).toBeNull()
  })

  it('initTogglely() destroys the previous instance', () => {
    initTogglely(config)
    initTogglely(config)
    expect(mockDestroy).toHaveBeenCalledTimes(1)
  })
})
