import { CallToolRequest, CallToolResultSchema, ListToolsResult, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { BaseToolkit, tool, Tool } from '@langchain/core/tools'
import { z } from 'zod'

// --- Shutdown Cleanup ---
// Export the set so CustomMCP can add to it
export const activeToolkits = new Set<MCPToolkit>()
let shuttingDown = false // Prevent race conditions during shutdown
// --- End Shutdown Cleanup ---

export class MCPToolkit extends BaseToolkit {
    tools: Tool[] = []
    _tools: ListToolsResult | null = null
    server_config: any
    transport: StdioClientTransport | null = null
    client: Client | null = null
    // Add unique ID for tracking and config hash storage
    public readonly id = `mcp-tk-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`
    public configHash?: string // To store a hash/representation of the config it was created with

    constructor(serverParams: any, transportType: 'stdio' | 'sse') {
        super()
        this.transport = null

        if (transportType === 'stdio') {
            // Store server params for initialization
            this.server_config = serverParams
        } else {
            // TODO: SSE transport
        }
    }

    async initialize() {
        if (this.client !== null && this._tools !== null) {
            // Already initialized
            return
        }

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

            // Setup transport configuration from server_config
            this.setupTransport(this.server_config)

            if (this.transport) {
                // Connect client to transport (this will likely spawn the process)
                await this.client.connect(this.transport)

                // List available tools
                this._tools = await this.client.request({ method: 'tools/list' }, ListToolsResultSchema)
                this.tools = await this.get_tools()
            } else {
                throw new Error('Failed to initialize transport')
            }
        } catch (error) {
            console.error('MCP Initialization Error:', error)
            // Ensure we clean up partially initialized state
            await this.cleanup()
            // Re-throw the error to propagate it
            throw error
        }
    }

    // New method to configure the transport
    private setupTransport(config: any): void {
        try {
            const { command, args, env } = config

            if (!command) {
                throw new Error('Server command is required in MCP config')
            }

            // Merge process.env with custom env variables
            const processEnv = { ...process.env, ...(env || {}) }

            // Handle npx on Windows
            let finalCommand = command
            if (command === 'npx' && process.platform === 'win32') {
                finalCommand = 'npx.cmd'
            }

            // Create the transport, passing command, args, and the merged env
            this.transport = new StdioClientTransport({
                command: finalCommand,
                args: args || [],
                // Pass the merged environment variables here
                env: processEnv
            })
        } catch (error) {
            console.error('Error setting up MCP transport:', error)
            this.transport = null // Ensure transport is null if setup fails
            throw error // Re-throw
        }
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
        // Don't run cleanup multiple times or during shutdown race conditions
        if (!activeToolkits.has(this)) {
            // eslint-disable-next-line no-console
            console.log(`MCPToolkit ${this.id}: Cleanup already called or instance not active.`)
            return
        }
        // eslint-disable-next-line no-console
        console.log(`Cleaning up MCPToolkit ${this.id}`)
        // Remove from registry FIRST to prevent re-entry during shutdown loop
        activeToolkits.delete(this)

        // Close client connection if connected
        if (this.client) {
            try {
                // Using the connect method in the reverse way since there's no explicit disconnect
                // This is a workaround since we couldn't confirm if disconnect exists
                if (this.transport) {
                    // **Attempt to properly close the transport (which should handle the process)**
                    // Replace 'destroy' with the actual method if available (e.g., close, disconnect)
                    if (typeof (this.transport as any).destroy === 'function') {
                        try {
                            ;(this.transport as any).destroy()
                            // eslint-disable-next-line no-console
                            console.log(`MCPToolkit ${this.id}: Transport destroyed.`)
                        } catch (transportErr) {
                            console.error(`MCPToolkit ${this.id}: Error destroying transport:`, transportErr)
                        }
                    } else {
                        // eslint-disable-next-line no-console
                        console.warn(`MCPToolkit ${this.id}: Transport has no 'destroy' method. Process might be orphaned.`)
                    }
                    this.transport = null
                }
            } catch (error) {
                console.error('Error during MCP client/transport cleanup:', error)
            }
            this.client = null
        }

        this.transport = null
        this._tools = null
        this.tools = []
        // eslint-disable-next-line no-console
        console.log(`Cleanup finished for MCPToolkit ${this.id}`)
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

// --- Shutdown Cleanup Logic ---
async function shutdownGracefully(signal: string) {
    // Ensure this runs only once
    if (shuttingDown) return
    shuttingDown = true
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}. Attempting graceful shutdown for ${activeToolkits.size} MCPToolkit(s)...`)
    // Create a copy of the set to iterate over safely, as cleanup modifies the set
    const toolkitsToClean = new Set(activeToolkits)
    if (toolkitsToClean.size === 0) {
        // eslint-disable-next-line no-console
        console.log('No active MCPToolkits found to clean up.')
        return
    }
    const cleanupPromises = []
    for (const toolkit of toolkitsToClean) {
        // eslint-disable-next-line no-console
        console.log(`Cleaning up toolkit ${toolkit.id} via shutdown hook...`)
        // cleanup() removes the toolkit from the original activeToolkits set
        cleanupPromises.push(toolkit.cleanup())
    }
    try {
        // Wait for all cleanup attempts to settle
        await Promise.allSettled(cleanupPromises)
        // eslint-disable-next-line no-console
        console.log('Finished MCPToolkit cleanup attempts.')
    } catch (e) {
        // Should not happen with allSettled, but log just in case
        // eslint-disable-next-line no-console
        console.error('Unexpected error during MCPToolkit cleanup:', e)
    }
}

// Register the shutdown listeners only once
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
signals.forEach((signal) => {
    process.once(signal, () => shutdownGracefully(signal)) // Use 'once' to avoid multiple listeners if code reloads
})
// Consider adding uncaughtException/unhandledRejection handlers here too if needed
// --- End Shutdown Cleanup Logic ---
