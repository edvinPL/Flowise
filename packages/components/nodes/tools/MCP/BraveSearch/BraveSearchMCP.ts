import { Tool } from '@langchain/core/tools'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../../src/Interface'
import { getCredentialData, getCredentialParam, getNodeModulesPackagePath } from '../../../../src/utils'
import { MCPToolkit, activeToolkits } from '../core'

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
            // If listActions is called (likely via refresh), cleanup the existing runtime instance.
            const cachedInstance = nodeData.instance as MCPToolkit | undefined;
            if (cachedInstance && cachedInstance instanceof MCPToolkit) {
                console.log(`Refresh triggered: Cleaning up existing MCPToolkit instance ${cachedInstance.id} for node ${nodeData.id}`);
                await cachedInstance.cleanup(); // Attempt cleanup
                nodeData.instance = undefined; // Clear the instance from nodeData
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
        // The config hash for Brave Search is just the API key, since that's all that can change
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const braveApiKey = getCredentialParam('braveApiKey', credentialData, nodeData)
        const currentConfigHash = `braveApiKey:${braveApiKey}`

        const cachedInstance = nodeData.instance as MCPToolkit | undefined

        // Check if a valid instance already exists and config hasn't changed
        if (cachedInstance && cachedInstance instanceof MCPToolkit && cachedInstance.configHash === currentConfigHash) {
            console.log(`Reusing cached Brave Search MCPToolkit instance ${cachedInstance.id} for node ${nodeData.id}`)
            return cachedInstance
        }

        // --- Config changed or no instance exists ---
        // Cleanup old instance if it exists and config has changed
        if (cachedInstance && cachedInstance instanceof MCPToolkit && cachedInstance.configHash !== currentConfigHash) {
            console.log(`Config changed for Brave Search MCP node ${nodeData.id}. Cleaning up old toolkit instance ${cachedInstance.id}.`)
            await cachedInstance.cleanup() // This should remove it from activeToolkits too
            nodeData.instance = undefined // Clear the instance from nodeData
        }

        // --- Create and initialize a new one ---
        console.log(`Creating new Brave Search MCPToolkit instance for node ${nodeData.id}`)
        const toolkit = await this.createAndInitToolkit(nodeData, options)
        toolkit.configHash = currentConfigHash // Store hash/config on instance for check

        // Cache the initialized instance
        nodeData.instance = toolkit

        // Add to global registry for shutdown cleanup
        activeToolkits.add(toolkit)
        console.log(`Brave Search MCPToolkit ${toolkit.id} added to active registry.`)

        return toolkit
    }

    /**
     * Fetches tools by creating a temporary toolkit instance (used for listActions).
     */
    async fetchToolsFromServer(nodeData: INodeData, options: ICommonObject): Promise<Tool[]> {
        console.log(`Fetching tools via temporary instance for Brave Search node ${nodeData.id}`)
        let tempToolkit: MCPToolkit | undefined = undefined
        try {
            tempToolkit = await this.createAndInitToolkit(nodeData, options)
            const tools = tempToolkit.tools ?? []
            // We got the tools. Now, try to clean up the temporary toolkit/process.
            setTimeout(async () => {
                if (tempToolkit) {
                    console.log(`Cleaning up temporary toolkit ${tempToolkit.id} used for listing Brave Search actions.`)
                    await tempToolkit.cleanup()
                }
            }, 500) // Short delay before cleaning up temporary instance
            return tools as Tool[]
        } catch (error) {
            console.error(`Error fetching tools for Brave Search node ${nodeData.id}:`, error)
            if (tempToolkit) {
                console.log(`Attempting cleanup after error for temporary toolkit ${tempToolkit.id}`)
                await tempToolkit.cleanup().catch(cleanupError => console.error(`Error during cleanup after error:`, cleanupError));
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
