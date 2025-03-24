import { Tool } from '@langchain/core/tools'
import { INode, INodeData, INodeOptionsValue, INodeParams } from '../../../../src/Interface'
import { MCPToolkit } from '../core'

const mcpServerConfig = `{
    "command": "npx",
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
                label: 'Available Actions',
                name: 'mcpActions',
                type: 'asyncMultiOptions',
                loadMethod: 'listActions',
                refresh: true,
                description: 'Select which MCP tools to expose to the LLM'
            }
        ]
        this.baseClasses = ['Tool']
    }

    //@ts-ignore
    loadMethods = {
        listActions: async (nodeData: INodeData): Promise<INodeOptionsValue[]> => {
            try {
                const toolset = await this.getTools(nodeData)
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
            const tools = await this.getTools(nodeData)

            const _mcpActions = nodeData.inputs?.mcpActions
            let mcpActions = []
            if (_mcpActions) {
                try {
                    mcpActions = typeof _mcpActions === 'string' ? JSON.parse(_mcpActions) : _mcpActions
                } catch (error) {
                    console.error('Error parsing MCP actions:', error)
                }
            }

            return tools.filter((tool: any) => mcpActions.includes(tool.name))
        } catch (error) {
            console.error('Error initializing MCP node:', error)
            throw error
        }
    }

    async getTools(nodeData: INodeData): Promise<Tool[]> {
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

            const tools = toolkit.tools ?? []
            return tools as Tool[]
        } catch (error) {
            throw new Error(`MCP Server initialization failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    convertToValidJSONString(inputString: string): string {
        try {
            // First try direct JSON parsing
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