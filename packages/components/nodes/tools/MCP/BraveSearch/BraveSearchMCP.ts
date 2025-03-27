import { Tool } from '@langchain/core/tools'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../../src/Interface'
import { getCredentialData, getCredentialParam, getNodeModulesPackagePath } from '../../../../src/utils'
import { MCPToolkit, activeToolkits } from '../core'

// --- Module-Level Cache ---
// Store runtime instances keyed by node ID
const runtimeInstances = new Map<string, MCPToolkit>()
// --- End Module-Level Cache ---

class BraveSearch_MCP implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    documentation: string
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Brave Search MCP'
        this.name = 'braveSearchMCP'
        this.version = 1.0
        this.type = 'BraveSearch MCP Tool'
        this.icon = 'brave.svg'
        this.category = 'Tools (MCP)'
        this.description = 'MCP server that integrates the Brave Search API - a real-time API to access web search capabilities'
        this.documentation = 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search'
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['braveSearchApi']
        }
        this.inputs = [
            {
                label: 'Use All Available Actions',
                name: 'useAllActions',
                type: 'boolean',
                default: true,
                description: 'Whether to automatically use all actions provided by the MCP server'
            },
            {
                label: 'Available Actions',
                name: 'mcpActions',
                type: 'asyncMultiOptions',
                loadMethod: 'listActions',
                refresh: true,
                optional: {
                    'inputs.useAllActions': ['false']
                },
                description: 'Select which Brave Search tools to expose to the LLM'
            }
        ]
        this.baseClasses = ['Tool']
    }

    //@ts-ignore
    loadMethods = {
        listActions: async (nodeData: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> => {
            // --- Refresh Button Logic ---
            // Cleanup instance from module cache if refresh is triggered
            const instanceFromCache = runtimeInstances.get(nodeData.id)
            if (instanceFromCache) {
                // eslint-disable-next-line no-console
                console.log(`Refresh triggered: Cleaning up cached MCPToolkit instance ${instanceFromCache.id} for node ${nodeData.id}`)
                // Remove from module cache *before* calling cleanup
                runtimeInstances.delete(nodeData.id)
                // Cleanup will handle removing from the global activeToolkits set
                await instanceFromCache.cleanup()
            }
            // --- End Refresh Button Logic ---

            try {
                const toolset = await this.fetchToolsFromServer(nodeData, options)
                toolset.sort((a: any, b: any) => a.name.localeCompare(b.name))

                return toolset.map(({ name, ...rest }) => ({
                    label: name.toUpperCase(),
                    name: name,
                    description: rest.description || name
                }))
            } catch (error) {
                console.error('Error listing Brave Search actions:', error)
                return [
                    {
                        label: 'No Available Actions',
                        name: 'error',
                        description: error instanceof Error ? error.message : 'No available actions, please check your API key and refresh'
                    }
                ]
            }
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        try {
            // Get the cached or newly initialized toolkit instance for runtime
            const toolkit = await this.getRuntimeToolkit(nodeData, options)
            const allTools = toolkit.tools ?? [] // Get all tools from the instance
            const useAllActions = (nodeData.inputs?.useAllActions as boolean) ?? true

            // If 'Use All Actions' is checked, return all tools immediately
            if (useAllActions) {
                return allTools
            }

            // --- Logic for when 'Use All Actions' is false ---
            const _mcpActions = nodeData.inputs?.mcpActions
            let mcpActions: string[] = [] // Ensure type is string array
            if (_mcpActions) {
                try {
                    mcpActions = typeof _mcpActions === 'string' ? JSON.parse(_mcpActions) : _mcpActions
                } catch (error) {
                    console.error('Error parsing mcp actions:', error)
                }
            }

            // If mcpActions array is empty (and useAllActions is false), return no tools
            if (mcpActions.length === 0) {
                console.warn("Brave Search MCP Node: 'Use All Actions' is off, but no specific actions were selected.")
                return [] // Return empty array - no tools available to the agent
            }

            // Filter the tools based on the selected action names
            return allTools.filter((tool: Tool) => mcpActions.includes(tool.name))
        } catch (error) {
            console.error('Error initializing Brave Search MCP node:', error)
            throw error
        }
    }

    /**
     * Gets or creates the MCPToolkit instance, caching it on nodeData.instance for runtime use.
     */
    async getRuntimeToolkit(nodeData: INodeData, options: ICommonObject): Promise<MCPToolkit> {
        // eslint-disable-next-line no-console
        console.log(`\nBrave Search MCP Node ${nodeData.id}: --- getRuntimeToolkit called ---`)

        // The config hash for Brave Search is just the API key, since that's all that can change
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const braveApiKey = getCredentialParam('braveApiKey', credentialData, nodeData)
        const currentConfigHash = `braveApiKey:${braveApiKey}`
        // eslint-disable-next-line no-console
        console.log(`Brave Search MCP Node ${nodeData.id}: Current config representation: ${currentConfigHash}`)

        // Check module cache `runtimeInstances` instead of `nodeData.instance`
        const cachedInstance = runtimeInstances.get(nodeData.id)

        // Log cache status
        let isInstanceValid = false
        let isHashMatching = false

        if (cachedInstance) {
            // eslint-disable-next-line no-console
            console.log(`Brave Search MCP Node ${nodeData.id}: Found instance in module cache. ID: ${cachedInstance.id}`)
            isInstanceValid = true // Assuming if it's in the cache, it's the right type
            isHashMatching = cachedInstance.configHash === currentConfigHash
            // eslint-disable-next-line no-console
            console.log(`Brave Search MCP Node ${nodeData.id}: Cached configHash: ${cachedInstance.configHash}`)
        } else {
            // eslint-disable-next-line no-console
            console.log(`Brave Search MCP Node ${nodeData.id}: No instance found in module cache for node ID ${nodeData.id}.`)
        }
        // eslint-disable-next-line no-console
        console.log(`Brave Search MCP Node ${nodeData.id}: Cache Check Results: isInstanceValid = ${isInstanceValid}, isHashMatching = ${isHashMatching}`)

        // Return from cache if valid and matching
        if (isInstanceValid && isHashMatching) {
            // eslint-disable-next-line no-console
            console.log(`Brave Search MCP Node ${nodeData.id}: Cache HIT. Reusing instance ${cachedInstance.id} from module cache.`)
            return cachedInstance
        }

        // --- Cache MISS or Config Change ---
        // eslint-disable-next-line no-console
        console.log(`Brave Search MCP Node ${nodeData.id}: Cache MISS or config changed.`)

        // Cleanup old instance if it existed but config changed
        if (isInstanceValid && !isHashMatching) {
            // eslint-disable-next-line no-console
            console.log(`Brave Search MCP Node ${nodeData.id}: Config changed. Cleaning up old toolkit instance ${cachedInstance.id}. Old hash: ${cachedInstance.configHash}`)
            // Remove from module cache *before* calling cleanup
            runtimeInstances.delete(nodeData.id)
            // Cleanup will handle removing from the global activeToolkits set
            await cachedInstance.cleanup()
        }

        // --- Create and initialize a new one ---
        // eslint-disable-next-line no-console
        console.log(`Brave Search MCP Node ${nodeData.id}: Creating NEW MCPToolkit instance...`)
        const toolkit = await this.createAndInitToolkit(nodeData, options)
        toolkit.configHash = currentConfigHash // Store hash/config on instance for check
        // eslint-disable-next-line no-console
        console.log(`Brave Search MCP Node ${nodeData.id}: NEW Toolkit ${toolkit.id} created and initialized.`)

        // Cache the initialized instance in the module map
        runtimeInstances.set(nodeData.id, toolkit) // Use module map here
        // eslint-disable-next-line no-console
        console.log(`Brave Search MCP Node ${nodeData.id}: Stored NEW toolkit ${toolkit.id} in module cache.`)

        // Add to global registry for shutdown cleanup
        activeToolkits.add(toolkit)
        // eslint-disable-next-line no-console
        console.log(`Brave Search MCP Node ${nodeData.id}: NEW toolkit ${toolkit.id} added to active registry.`)

        return toolkit
    }

    /**
     * Fetches tools by creating a temporary toolkit instance (used for listActions).
     */
    async fetchToolsFromServer(nodeData: INodeData, options: ICommonObject): Promise<Tool[]> {
        // eslint-disable-next-line no-console
        console.log(`Fetching tools via temporary instance for Brave Search node ${nodeData.id}`)
        // We MUST ensure temporary instances don't get added to runtimeInstances map
        let tempToolkit: MCPToolkit | undefined = undefined
        try {
            // createAndInitToolkit doesn't add to caches/registries, safe to call
            tempToolkit = await this.createAndInitToolkit(nodeData, options)
            const tools = tempToolkit.tools ?? []

            // Best-effort cleanup for the temporary instance. It was never in runtimeInstances.
            // It *was* added to activeToolkits, so cleanup will remove it from there.
            setTimeout(async () => {
                if (tempToolkit) {
                    // eslint-disable-next-line no-console
                    console.log(`Cleaning up temporary toolkit ${tempToolkit.id} used for listing Brave Search actions.`)
                    await tempToolkit.cleanup()
                }
            // Removed delay, cleanup should be relatively quick. Fire and forget.
            }, 0)

            return tools as Tool[]
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`Error fetching tools for Brave Search node ${nodeData.id}:`, error)
            if (tempToolkit) {
                // eslint-disable-next-line no-console
                console.log(`Attempting cleanup after error for temporary toolkit ${tempToolkit.id}`)
                await tempToolkit.cleanup().catch((cleanupError) => console.error(`Error during cleanup after error:`, cleanupError))
            }
            throw error
        }
    }

    /**
     * Creates and initializes a new MCPToolkit instance based on nodeData config.
     */
    async createAndInitToolkit(nodeData: INodeData, options: ICommonObject): Promise<MCPToolkit> {
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const braveApiKey = getCredentialParam('braveApiKey', credentialData, nodeData)

        if (!braveApiKey) {
            throw new Error('Brave API Key is required')
        }

        const packagePath = getNodeModulesPackagePath('@modelcontextprotocol/server-brave-search/dist/index.js')

        const serverParams = {
            command: 'node',
            args: [packagePath],
            env: {
                BRAVE_API_KEY: braveApiKey
            }
        }

        const toolkit = new MCPToolkit(serverParams, 'stdio')
        await toolkit.initialize()

        if (!toolkit.tools) {
            throw new Error(`Toolkit ${toolkit.id} initialization succeeded but tools list is empty.`)
        }

        return toolkit
    }
}

module.exports = { nodeClass: BraveSearch_MCP }
