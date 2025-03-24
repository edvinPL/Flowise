import { CallToolRequest, CallToolResultSchema, ListToolsResult, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { BaseToolkit, tool, Tool } from '@langchain/core/tools'
import { z } from 'zod'
import { spawn, ChildProcess } from 'child_process'

// Map to track all processes across instances
const processRegistry = new Map<string, ChildProcess>()

// Add process termination handler
process.on('exit', () => {
    // Terminate all child processes when the main process exits
    for (const childProcess of processRegistry.values()) {
        try {
            if (childProcess.exitCode === null) {
                childProcess.kill('SIGTERM')
            }
        } catch (error) {
            console.error('Error terminating child process:', error)
        }
    }
})

export class MCPToolkit extends BaseToolkit {
    tools: Tool[] = []
    _tools: ListToolsResult | null = null
    model_config: any
    transport: StdioClientTransport | null = null
    client: Client | null = null
    process: ChildProcess | null = null
    processId: string

    constructor(serverParams: any, transportType: 'stdio' | 'sse') {
        super()
        this.transport = null
        this.process = null
        this.processId = `mcp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`

        if (transportType === 'stdio') {
            // Store server params for initialization
            this.model_config = serverParams
        } else {
            // TODO: SSE transport
        }
    }

    async initialize() {
        if (this._tools === null) {
            try {
                // Create client
                this.client = new Client(
                    {
                        name: 'flowise-client',
                        version: '1.0.0'
                    },
                    {
                        capabilities: {}
                    }
                )

                if (this.transport === null && this.model_config) {
                    // Spawn the server process
                    await this._spawnProcess(this.model_config)

                    // Connect client to transport
                    if (this.transport) {
                        await this.client.connect(this.transport)

                        // List available tools
                        this._tools = await this.client.request({ method: 'tools/list' }, ListToolsResultSchema)
                        this.tools = await this.get_tools()
                    } else {
                        throw new Error('Failed to initialize transport after spawning process')
                    }
                } else {
                    throw new Error('Transport is not initialized or model config is missing')
                }
            } catch (error) {
                // Ensure we clean up process if initialization fails
                await this.cleanup()
                throw error
            }
        }
    }

    private async _spawnProcess(config: any): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const { command, args, env } = config

                if (!command) {
                    reject(new Error('Server command is required'))
                    return
                }

                // Merge process.env with custom env variables
                const processEnv = { ...process.env, ...(env || {}) }

                let finalCommand = command
                if (command === 'npx' && process.platform === 'win32') {
                    finalCommand = 'npx.cmd'
                }

                this.process = spawn(finalCommand, args || [], {
                    env: processEnv,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    shell: true
                })

                processRegistry.set(this.processId, this.process)

                this.transport = new StdioClientTransport({
                    command: finalCommand,
                    args: args || []
                })

                if (this.process) {
                    this.process.on('error', () => {
                        // Handle process error
                    })

                    this.process.on('exit', () => {
                        processRegistry.delete(this.processId)
                    })

                    setTimeout(() => {
                        if (this.process && this.process.exitCode === null) {
                            resolve()
                        } else {
                            reject(new Error('MCP server process failed to start or exited too quickly'))
                        }
                    }, 2000)
                } else {
                    reject(new Error('Failed to spawn process'))
                }
            } catch (error) {
                reject(error)
            }
        })
    }

    async get_tools(): Promise<Tool[]> {
        if (this._tools === null || this.client === null) {
            throw new Error('Must initialize the toolkit first')
        }
        const toolsPromises = this._tools.tools.map(async (tool: any) => {
            if (this.client === null) {
                throw new Error('Client is not initialized')
            }
            return await MCPTool({
                client: this.client,
                name: tool.name,
                description: tool.description || '',
                argsSchema: createSchemaModel(tool.inputSchema)
            })
        })
        return Promise.all(toolsPromises)
    }

    async cleanup(): Promise<void> {
        // Close client connection if connected
        if (this.client) {
            try {
                // Using the connect method in the reverse way since there's no explicit disconnect
                // This is a workaround since we couldn't confirm if disconnect exists
                if (this.transport) {
                    this.transport = null
                }
            } catch (error) {
                console.error('Error closing MCP client connection:', error)
            }
            this.client = null
        }

        if (this.process) {
            try {
                processRegistry.delete(this.processId)

                if (this.process.exitCode === null) {
                    this.process.kill('SIGTERM')

                    setTimeout(() => {
                        if (this.process && this.process.exitCode === null) {
                            this.process.kill('SIGKILL')
                        }
                    }, 2000)
                }
            } catch (error) {
                console.error('Error terminating MCP server process:', error)
            }
            this.process = null
        }

        this.transport = null
        this._tools = null
        this.tools = []
    }
}

export async function MCPTool({
    client,
    name,
    description,
    argsSchema
}: {
    client: Client
    name: string
    description: string
    argsSchema: any
}): Promise<Tool> {
    return tool(
        async (input): Promise<string> => {
            const req: CallToolRequest = { method: 'tools/call', params: { name: name, arguments: input } }
            const res = await client.request(req, CallToolResultSchema)
            const content = res.content
            const contentString = JSON.stringify(content)
            return contentString
        },
        {
            name: name,
            description: description,
            schema: argsSchema
        }
    )
}

function createSchemaModel(
    inputSchema: {
        type: 'object'
        properties?: import('zod').objectOutputType<{}, import('zod').ZodTypeAny, 'passthrough'> | undefined
    } & { [k: string]: unknown }
): any {
    if (inputSchema.type !== 'object' || !inputSchema.properties) {
        throw new Error('Invalid schema type or missing properties')
    }
    const schemaProperties = Object.entries(inputSchema.properties).reduce((acc, [key, _]) => {
        acc[key] = z.any()
        return acc
    }, {} as Record<string, import('zod').ZodTypeAny>)
    return z.object(schemaProperties)
}
