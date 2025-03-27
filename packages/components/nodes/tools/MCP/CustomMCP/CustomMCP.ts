import { Tool } from '@langchain/core/tools'
import { INode, INodeData, INodeOptionsValue, INodeParams } from '../../../../src/Interface'
import { MCPToolkit, activeToolkits } from '../core'

// --- Module-Level Cache ---
// Store runtime instances keyed by node ID
const runtimeInstances = new Map<string, MCPToolkit>()
// --- End Module-Level Cache ---

const mcpServerConfig = `{
    "command": "${process.platform === 'win32' ? 'npx.cmd' : 'npx'}",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/files"],
    "env": {}
}`

class Custom_MCP implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    documentation: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'Custom MCP'
        this.name = 'customMCP'
        this.version = 1.0
        this.type = 'Custom MCP Tool'
        this.icon = 'customMCP.png'
        this.category = 'Tools (MCP)'
        this.description = 'Custom MCP Server Configuration for connecting to any MCP server'
        this.documentation = 'https://github.com/modelcontextprotocol/servers'
        this.inputs = [
            {
                label: 'MCP Server Config',
                name: 'mcpServerConfig',
                type: 'code',
                hideCodeExecute: true,
                description: 'JSON configuration for the MCP server including command, args, and environment variables',
                placeholder: mcpServerConfig
            },
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
                description: 'Select which MCP tools to expose to the LLM'
            }
        ]
        this.baseClasses = ['Tool']
    }

    //@ts-ignore
    loadMethods = {
        listActions: async (nodeData: INodeData): Promise<INodeOptionsValue[]> => {
            // Check if config is missing during load
            const mcpServerConfig = nodeData.inputs?.mcpServerConfig as string | undefined
            if (!mcpServerConfig) {
                return [
                    {
                        label: 'No Actions Available Yet',
                        name: 'config_missing',
                        description: 'Configure and save the MCP Server Config first, then refresh'
                    }
                ]
            }

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
                // Use the method that creates a temporary instance for listing
                const toolset = await this.fetchToolsFromServer(nodeData)
                toolset.sort((a: any, b: any) => a.name.localeCompare(b.name))

                return toolset.map(({ name, ...rest }) => ({
                    label: name.toUpperCase(),
                    name: name,
                    description: rest.description || name
                }))
            } catch (error) {
                console.error('Error listing MCP actions:', error)
                return [
                    {
                        label: 'No Available Actions',
                        name: 'error',
                        description: error instanceof Error ? error.message : 'Failed to connect to MCP server'
                    }
                ]
            }
        }
    }

    async init(nodeData: INodeData): Promise<any> {
        console.log(`MCP Node ${nodeData.id}: init() called`) // Confirm init call frequency
        try {
            // Get the cached or newly initialized toolkit instance for runtime
            const toolkit = await this.getRuntimeToolkit(nodeData)
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
                    console.error('Error parsing MCP actions:', error)
                }
            }

            // If mcpActions array is empty (and useAllActions is false), return no tools
            if (mcpActions.length === 0) {
                console.warn("MCP Node: 'Use All Actions' is off, but no specific actions were selected.")
                return [] // Return empty array - no tools available to the agent
            }

            // Filter the tools based on the selected action names
            return allTools.filter((tool: Tool) => mcpActions.includes(tool.name))
        } catch (error) {
            console.error('Error initializing MCP node:', error)
            throw error
        }
    }

    /**
     * Gets or creates the MCPToolkit instance, caching it on nodeData.instance for runtime use.
     * Also handles cleanup on config change and registers for shutdown cleanup.
     */
    async getRuntimeToolkit(nodeData: INodeData): Promise<MCPToolkit> {
        console.log(`\nMCP Node ${nodeData.id}: --- getRuntimeToolkit called ---`)

        const currentConfigString = JSON.stringify(nodeData.inputs?.mcpServerConfig ?? '')
        const currentConfigHash = currentConfigString // Replace with actual hash if needed
        console.log(`MCP Node ${nodeData.id}: Current config representation: ${currentConfigHash}`)

        const cachedInstance = runtimeInstances.get(nodeData.id)
        let isInstanceValid = false
        let isHashMatching = false

        if (cachedInstance) {
            console.log(`MCP Node ${nodeData.id}: Found instance in module cache. ID: ${cachedInstance.id}`)
            isInstanceValid = true // Assuming if it's in the cache, it's the right type
            isHashMatching = cachedInstance.configHash === currentConfigHash
            console.log(`MCP Node ${nodeData.id}: Cached configHash: ${cachedInstance.configHash}`)
        } else {
            console.log(`MCP Node ${nodeData.id}: No instance found in module cache for this node ID.`)
        }
        console.log(`MCP Node ${nodeData.id}: Cache Check Results: isInstanceValid = ${isInstanceValid}, isHashMatching = ${isHashMatching}`)

        // Check if a valid instance already exists and config hasn't changed
        if (isInstanceValid && isHashMatching) {
            console.log(`MCP Node ${nodeData.id}: Cache HIT. Reusing instance ${cachedInstance.id}`)
            return cachedInstance
        }

        // --- Cache MISS or Config Change ---
        console.log(`MCP Node ${nodeData.id}: Cache MISS or config changed.`)

        // Cleanup old instance if it existed but config changed
        if (isInstanceValid && !isHashMatching) {
            console.log(`MCP Node ${nodeData.id}: Config changed. Cleaning up old toolkit instance ${cachedInstance.id}. Old hash: ${cachedInstance.configHash}`)
            // Remove from module cache *before* calling cleanup
            runtimeInstances.delete(nodeData.id)
            // Cleanup will handle removing from the global activeToolkits set
            await cachedInstance.cleanup()
        }

        // --- Create and initialize a new one ---
        console.log(`MCP Node ${nodeData.id}: Creating NEW MCPToolkit instance...`)
        let toolkit: MCPToolkit
        try {
            toolkit = await this.createAndInitToolkit(nodeData)
            toolkit.configHash = currentConfigHash // Store hash/config on instance for check
            console.log(`MCP Node ${nodeData.id}: NEW Toolkit ${toolkit.id} created and initialized.`)
        } catch (creationError) {
            console.error(`MCP Node ${nodeData.id}: FATAL error during NEW toolkit creation/initialization:`, creationError)
            throw creationError // Rethrow
        }

        // Cache the initialized instance in the module map
        runtimeInstances.set(nodeData.id, toolkit)
        console.log(`MCP Node ${nodeData.id}: Stored NEW toolkit ${toolkit.id} in module cache.`)

        // Add to global registry for shutdown cleanup
        activeToolkits.add(toolkit)
        console.log(`MCP Node ${nodeData.id}: NEW toolkit ${toolkit.id} added to active registry.`)
        console.warn(
            `MCP Node ${nodeData.id}: MCPToolkit instance ${toolkit.id} created. Process cleanup relies on server shutdown or config change/refresh. Node deletion may orphan processes.`
        )

        return toolkit
    }

    /**
     * Fetches tools by creating a temporary toolkit instance (used for listActions).
     * Does not cache the instance or add to the global registry.
     */
    async fetchToolsFromServer(nodeData: INodeData): Promise<Tool[]> {
        // eslint-disable-next-line no-console
        console.log(`Fetching tools via temporary instance for node ${nodeData.id}`)
        // We MUST ensure temporary instances don't get added to runtimeInstances map
        let tempToolkit: MCPToolkit | undefined = undefined
        try {
            // createAndInitToolkit doesn't add to caches/registries, safe to call
            tempToolkit = await this.createAndInitToolkit(nodeData)
            const tools = tempToolkit.tools ?? []

            // Best-effort cleanup for the temporary instance. It was never in runtimeInstances.
            // It *was* added to activeToolkits, so cleanup will remove it from there.
            setTimeout(async () => {
                if (tempToolkit) {
                    // eslint-disable-next-line no-console
                    console.log(`Cleaning up temporary toolkit ${tempToolkit.id} used for listing actions.`)
                    await tempToolkit.cleanup()
                }
            // Removed delay, cleanup should be relatively quick. Fire and forget.
            }, 0)

            return tools as Tool[]
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`Error fetching tools via temporary instance for node ${nodeData.id}:`, error)
            // If toolkit creation failed, tempToolkit might be undefined.
            // If init failed but toolkit exists, cleanup might be needed.
            if (tempToolkit) {
                // eslint-disable-next-line no-console
                console.log(`Attempting cleanup after error for temporary toolkit ${tempToolkit.id}`)
                await tempToolkit.cleanup().catch((cleanupError) => console.error(`Error during cleanup after error:`, cleanupError))
            }
            throw error // Re-throw for listActions error display
        }
    }

    /**
     * Creates and initializes a new MCPToolkit instance based on nodeData config.
     * Does NOT add to global registry or cache on nodeData.instance itself.
     */
    async createAndInitToolkit(nodeData: INodeData): Promise<MCPToolkit> {
        const mcpServerConfig = nodeData.inputs?.mcpServerConfig as string

        if (!mcpServerConfig) {
            throw new Error('MCP Server Config is required')
        }

        try {
            let serverParams
            if (typeof mcpServerConfig === 'object') {
                serverParams = mcpServerConfig
            } else if (typeof mcpServerConfig === 'string') {
                const serverParamsString = this.convertToValidJSONString(mcpServerConfig)
                serverParams = JSON.parse(serverParamsString)
            }

            // Validate required parameters
            if (!serverParams.command) {
                throw new Error('MCP Server Config must include a "command" property')
            }

            // Create and initialize the toolkit
            const toolkit = new MCPToolkit(serverParams, 'stdio')
            await toolkit.initialize()

            // Check if tools are populated after initialization
            if (!toolkit.tools) {
                throw new Error(`Toolkit ${toolkit.id} initialization succeeded but tools list is empty.`)
            }
            return toolkit // Return the initialized toolkit instance
        } catch (error) {
            // Log detailed error during creation/init
            console.error(`Error creating/initializing MCPToolkit for node ${nodeData.id}:`, error)
            // Rethrow a more specific error message
            throw new Error(`MCP Server initialization failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    convertToValidJSONString(inputString: string): string {
        try {
            // First try, direct JSON parsing
            JSON.parse(inputString)
            return inputString
        } catch (e) {
            // If that fails, try to evaluate as a JavaScript object
            try {
                const jsObject = Function('return ' + inputString)()
                return JSON.stringify(jsObject, null, 2)
            } catch (error) {
                console.error('Error converting to JSON:', error)
                throw new Error('Invalid MCP Server Config format')
            }
        }
    }
}

module.exports = { nodeClass: Custom_MCP }
