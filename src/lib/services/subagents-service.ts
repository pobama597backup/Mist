// M.I.S.T. sub-agents — specialized workers under Mist's command.
//
// v7 rebuild: an agent run is now a MISSION. The old path fired a single
// unified() call (one 8-round chain max); the mission engine gives every
// agent run a real plan → act → verify → report loop with its own budgets,
// failure adaptation, and a skeptical verifier — the same "do anything"
// machinery Mist uses for herself, scoped to the agent's persona.
//
// Human-in-the-loop preserved: AgentRun rows still record every run's goal,
// outcome, tools and duration, and Mist (the orchestrator) reports results.
import { db } from '@/lib/db'
import type { SubAgent, AgentRun, Mission } from '@prisma/client'
import { logAutonomyEvent } from './autonomy-service'
import type { ToolInfo } from '@/lib/types'

export interface SubAgentSpec {
  id: string
  name: string
  role: string
  description: string
  systemPrompt: string
  status: 'active' | 'paused'
  goal: string
  tools: ToolInfo[]
}

export interface SubAgentRunResult {
  success: boolean
  result: string
  missionId?: string
  toolsUsed: string[]
  error?: string
}

/** The creator's requested starter crew — seeded once, idempotent. */
const DEFAULT_AGENTS: { name: string; role: string; description: string; systemPrompt: string }[] = [
  {
    name: 'Marketing Manager',
    role: 'marketing',
    description:
      'Plans and executes marketing for the creator\'s business: campaign ideas, content calendars, social posts, copy, and performance reviews using live research.',
    systemPrompt: `You are Mist's Marketing Manager sub-agent — a sharp, pragmatic marketing brain serving the creator's business. You think in campaigns, audiences, positioning and measurable outcomes. When given a goal, you research real market context first (use web_search / deep_research tools when available), then produce concrete, ready-to-use deliverables: copy, calendars, post drafts, launch checklists. Prefer specific, actionable output over generic marketing theory. Always note assumptions about the business and ask for the missing facts in your final report rather than inventing them. Be honest about what you could not verify.`,
  },
  {
    name: 'Information Agent',
    role: 'information',
    description:
      'Research and intelligence: finds, cross-checks and compiles current information on any topic, with sources, into briefs the creator can act on.',
    systemPrompt: `You are Mist's Information Agent — a meticulous research and intelligence sub-agent. Your job is to find, cross-check and compile current information into clear, sourced briefs. Use web_search / read_page / deep_research tools aggressively; never answer from memory alone when live tools are available. Cross-check important claims across at least two independent sources and say when sources disagree. Deliver structured briefs: key findings first, then details, then sources, then confidence level and open questions. Never fabricate a source or a number.`,
  },
]

export class SubAgentsService {
  /** Seed the creator's starter crew once (idempotent, safe on every call). */
  static async seedDefaults(): Promise<void> {
    try {
      const count = await db.subAgent.count()
      if (count > 0) return
      for (const agent of DEFAULT_AGENTS) {
        await db.subAgent.create({ data: agent })
      }
      await logAutonomyEvent('subagent_seeded', `Starter crew seeded: ${DEFAULT_AGENTS.map((a) => a.name).join(', ')}`, {})
    } catch {
      // seeding is best-effort
    }
  }

  /** Get all sub-agents with their latest run (seeds defaults on first use). */
  static async listAgents() {
    await SubAgentsService.seedDefaults()
    return db.subAgent.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })
  }

  /** Get a specific sub-agent by ID */
  static async getAgent(id: string) {
    return db.subAgent.findUnique({
      where: { id },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    })
  }

  /** Create a new sub-agent */
  static async createAgent(data: {
    name: string
    role: string
    description?: string
    systemPrompt?: string
  }) {
    return db.subAgent.create({
      data: {
        name: data.name,
        role: data.role,
        description: data.description || '',
        systemPrompt: data.systemPrompt || '',
      },
    })
  }

  /** Update an existing sub-agent */
  static async updateAgent(
    id: string,
    data: {
      name?: string
      role?: string
      description?: string
      systemPrompt?: string
      status?: 'active' | 'paused'
    }
  ) {
    const updateData: Partial<SubAgent> = {}
    if (data.name !== undefined) updateData.name = data.name
    if (data.role !== undefined) updateData.role = data.role
    if (data.description !== undefined) updateData.description = data.description
    if (data.systemPrompt !== undefined) updateData.systemPrompt = data.systemPrompt
    if (data.status !== undefined) updateData.status = data.status

    return db.subAgent.update({
      where: { id },
      data: updateData,
    })
  }

  /** Delete a sub-agent */
  static async deleteAgent(id: string) {
    return db.subAgent.delete({
      where: { id },
    })
  }

  /**
   * Execute a task with a sub-agent — now a full MISSION: plan → act → verify →
   * report, powered by the mission engine with the agent's persona as its
   * brain. Returns IMMEDIATELY after launching (the mission runs in the
   * background; its completion alert lands in chat and the AgentRun row is
   * updated by the background poller — the UI's run history shows progress).
   */
  static async executeAgent(
    agentId: string,
    goal: string,
    _tools: ToolInfo[] | null,
    triggeredBy: 'user' | 'mist' | 'scheduler' = 'user'
  ): Promise<SubAgentRunResult> {
    const agent = await db.subAgent.findUnique({
      where: { id: agentId },
    })

    if (!agent) {
      throw new Error('Sub-agent not found')
    }

    if (agent.status !== 'active') {
      throw new Error('Sub-agent is not active')
    }

    // Create a new run record (human-in-the-loop bookkeeping)
    const run = await db.agentRun.create({
      data: {
        agentId,
        goal,
        status: 'running',
        triggeredBy,
        startedAt: new Date(),
      },
    })

    try {
      // Launch the mission with the agent's persona as its brain
      const { startMission, missionStatus } = await import('./mission-service')
      const mission = await startMission({
        goal,
        title: `${agent.name}: ${goal.slice(0, 60)}`,
        origin: 'subagent',
        agentId,
        persona: agent.systemPrompt || `You are ${agent.name}, a ${agent.role} sub-agent.`,
        maxSteps: 30,
        maxMinutes: 12,
      })

      const startedAt = Date.now()

      // Background watcher: poll the persisted mission row (the engine is
      // crash-safe; a server restart resumes the mission via heartbeat) and
      // record the outcome on the AgentRun + agent stats when it settles.
      void (async () => {
        try {
          const terminal = new Set(['done', 'failed', 'cancelled', 'awaiting_creator', 'paused'])
          const budgetMs = 13 * 60_000
          let row: Mission | null = mission
          while (Date.now() - startedAt < budgetMs) {
            await new Promise((r) => setTimeout(r, 2500))
            row = (await missionStatus(mission.id)) as Mission
            if (!row) break
            if (terminal.has(row.status)) break
          }
          const finished = row && terminal.has(row.status)
          const success = row?.status === 'done'
          const steps = (() => {
            try {
              return JSON.parse(row?.transcript || '[]') as { tool: string; ok: boolean }[]
            } catch {
              return [] as { tool: string; ok: boolean }[]
            }
          })()
          const toolsUsed = [...new Set(steps.filter((s) => s.ok && s.tool !== '(system)').map((s) => s.tool))]
          const durationMs = Date.now() - startedAt
          const resultText =
            row?.result?.trim() ||
            (finished ? '(no result text)' : `The mission is still running (status: ${row?.status ?? 'unknown'}).`)

          await db.agentRun.update({
            where: { id: run.id },
            data: {
              status: success ? 'done' : finished ? 'failed' : 'running',
              result: resultText.slice(0, 6000),
              log: JSON.stringify([
                `mission: ${row?.id ?? 'n/a'}`,
                ...steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.tool}`),
                `status: ${row?.status ?? 'unknown'}`,
              ]),
              toolsUsed: JSON.stringify(toolsUsed),
              ...(finished ? { finishedAt: new Date() } : {}),
              durationMs,
            },
          })

          if (success) {
            await db.subAgent.update({
              where: { id: agentId },
              data: { lastRunAt: new Date(), runCount: { increment: 1 } },
            })
          }

          await logAutonomyEvent('agent_run', `Agent ${agent.name} ${success ? 'completed' : 'ran'} task (mission ${row?.status})`, {
            agentId,
            goal,
            missionId: row?.id,
            success,
            durationMs,
          })
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error'
          await db.agentRun
            .update({
              where: { id: run.id },
              data: {
                status: 'failed',
                log: JSON.stringify([`watcher error: ${errorMessage}`]),
                finishedAt: new Date(),
                error: errorMessage,
              },
            })
            .catch(() => undefined)
        }
      })()

      return {
        success: true,
        result: `Mission launched (id: ${mission.id}) — ${agent.name} is planning and executing it now. The report will land in the chat when it completes (🎯), and the run appears in Diagnostics → Sub-agents → Run history.`,
        missionId: mission.id,
        toolsUsed: [],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await db.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          result: '',
          log: JSON.stringify([`error: ${errorMessage}`]),
          toolsUsed: '[]',
          finishedAt: new Date(),
          error: errorMessage,
        },
      })

      await logAutonomyEvent('agent_run', `Agent ${agent.name} failed to launch task`, {
        agentId,
        goal,
        success: false,
        error: errorMessage,
      })

      return {
        success: false,
        result: '',
        toolsUsed: [],
        error: errorMessage,
      }
    }
  }

  /** Get the status of a specific agent run */
  static async getRunStatus(runId: string) {
    return db.agentRun.findUnique({
      where: { id: runId },
      include: {
        agent: true,
      },
    })
  }

  /** Get all runs for a specific agent */
  static async getAgentRuns(agentId: string, limit = 10) {
    return db.agentRun.findMany({
      where: { agentId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        agent: true,
      },
    })
  }
}
