import { Tool } from '@langchain/core/tools'
import { INode, INodeData, INodeOptionsValue, INodeParams } from '../../../../src/Interface'
import { MCPToolkit, activeToolkits } from '../core'

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
            // If listActions is called (likely via refresh), cleanup the existing runtime instance.
            const cachedInstance = nodeData.instance as MCPToolkit | undefined
            if (cachedInstance && cachedInstance instanceof MCPToolkit) {
                // eslint-disable-next-line no-console
                console.log(`Refresh triggered: Cleaning up existing MCPToolkit instance ${cachedInstance.id} for node ${nodeData.id}`)
                await cachedInstance.cleanup() // Attempt cleanup
                nodeData.instance = undefined // Clear the instance from nodeData
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
        // Use a simple hash of the config string for comparison
        // NOTE: JSON.stringify order isn't guaranteed, a proper hash function would be better
        const currentConfigString = JSON.stringify(nodeData.inputs?.mcpServerConfig ?? '')
        const currentConfigHash = currentConfigString // Replace with actual hash if needed

        const cachedInstance = nodeData.instance as MCPToolkit | undefined

        // Check if a valid instance already exists and config hasn't changed
        if (cachedInstance && cachedInstance instanceof MCPToolkit && cachedInstance.configHash === currentConfigHash) {
            // eslint-disable-next-line no-console
            console.log(`Reusing cached MCPToolkit instance ${cachedInstance.id} for node ${nodeData.id}`)
            return cachedInstance
        }

        // --- Config changed or no instance exists ---
        // Cleanup old instance if it exists and config has changed
        if (cachedInstance && cachedInstance instanceof MCPToolkit && cachedInstance.configHash !== currentConfigHash) {
            // eslint-disable-next-line no-console
            console.log(`Config changed for MCP node ${nodeData.id}. Cleaning up old toolkit instance ${cachedInstance.id}.`)
            await cachedInstance.cleanup() // This should remove it from activeToolkits too
            nodeData.instance = undefined // Clear the instance from nodeData
        }

        // --- Create and initialize a new one ---
        // eslint-disable-next-line no-console
        console.log(`Creating new MCPToolkit instance for node ${nodeData.id}`)
        const toolkit = await this.createAndInitToolkit(nodeData)
        toolkit.configHash = currentConfigHash // Store hash/config on instance for check

        // Cache the initialized instance
        nodeData.instance = toolkit

        // Add to global registry for shutdown cleanup
        activeToolkits.add(toolkit)
        // eslint-disable-next-line no-console
        console.log(`MCPToolkit ${toolkit.id} added to active registry.`)
        // eslint-disable-next-line no-console
        console.warn(
            `MCPToolkit instance ${toolkit.id} created. Process cleanup relies on server shutdown or config change/refresh. Node deletion may orphan processes.`
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
        let tempToolkit: MCPToolkit | undefined = undefined
        try {
            tempToolkit = await this.createAndInitToolkit(nodeData)
            const tools = tempToolkit.tools ?? []
            // We got the tools. Now, try to clean up the temporary toolkit/process.
            // Add a small delay maybe, then call cleanup. This is best-effort.
            setTimeout(async () => {
                if (tempToolkit) {
                    // eslint-disable-next-line no-console
                    console.log(`Cleaning up temporary toolkit ${tempToolkit.id} used for listing actions.`)
                    // Pass 'true' to indicate it's a temporary cleanup, maybe prevents removal from activeToolkits if needed?
                    // Let's rely on cleanup always removing from the set for simplicity now.
                    await tempToolkit.cleanup()
                }
            }, 500) // Short delay before cleaning up temporary instance
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
