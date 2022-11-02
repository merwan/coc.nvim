'use strict'
import { Neovim } from '@chemzqm/neovim'
import { CancellationToken, Disposable, Location, Range } from 'vscode-languageserver-protocol'
import { URI } from 'vscode-uri'
import { ProviderResult } from '../provider'
import { IList, ListAction, ListArgument, ListContext, ListItem, ListTask, LocationWithLine, LocationWithTarget, MultipleListAction, SingleListAction, WorkspaceConfiguration } from '../types'
import { disposeAll } from '../util'
import { lineToLocation } from '../util/fs'
import { comparePosition, emptyRange } from '../util/position'
import workspace from '../workspace'
import CommandTask, { CommandTaskOption } from './commandTask'
import ListConfiguration from './configuration'

interface ActionOptions {
  persist?: boolean
  reload?: boolean
  parallel?: boolean
  tabPersist?: boolean
}

interface ArgumentItem {
  hasValue: boolean
  name: string
}

interface PreviewConfig {
  winid: number
  position: string
  hlGroup: string
  maxHeight: number
  name?: string
  splitRight: boolean
  lnum: number
  filetype?: string
  range?: Range
  scheme?: string
  targetRange?: Range
  toplineStyle: string
  toplineOffset: number
}

export interface PreviewOptions {
  bufname?: string
  filetype?: string
  lines: string[]
  lnum?: number
  range?: Range
  sketch?: boolean
}

export default abstract class BasicList implements IList, Disposable {
  public name: string
  public defaultAction = 'open'
  public readonly actions: ListAction[] = []
  public options: ListArgument[] = []
  protected disposables: Disposable[] = []
  private optionMap: Map<string, ArgumentItem>
  public config: ListConfiguration

  constructor(protected nvim: Neovim) {
    this.config = new ListConfiguration()
  }

  public get alignColumns(): boolean {
    return this.config.get('alignColumns', false)
  }

  protected get hlGroup(): string {
    return this.config.get('previewHighlightGroup', 'Search')
  }

  protected get previewHeight(): number {
    return this.config.get('maxPreviewHeight', 12)
  }

  protected get splitRight(): boolean {
    return this.config.get('previewSplitRight', false)
  }

  protected get toplineStyle(): string {
    return this.config.get('previewToplineStyle', 'offset')
  }

  protected get toplineOffset(): number {
    return this.config.get('previewToplineOffset', 3)
  }

  public parseArguments(args: string[]): { [key: string]: string | boolean } {
    if (!this.optionMap) {
      this.optionMap = new Map()
      for (let opt of this.options) {
        let parts = opt.name.split(/,\s*/g).map(s => s.replace(/\s+.*/g, ''))
        let name = opt.key ? opt.key : parts[parts.length - 1].replace(/^-/, '')
        for (let p of parts) {
          this.optionMap.set(p, { name, hasValue: opt.hasValue })
        }
      }
    }
    let res: { [key: string]: string | boolean } = {}
    for (let i = 0; i < args.length; i++) {
      let arg = args[i]
      let def = this.optionMap.get(arg)
      if (!def) continue
      let value: string | boolean = true
      if (def.hasValue) {
        value = args[i + 1] || ''
        i = i + 1
      }
      res[def.name] = value
    }
    return res
  }

  /**
   * Get configuration of current list
   */
  protected getConfig(): WorkspaceConfiguration {
    return workspace.getConfiguration(`list.source.${this.name}`)
  }

  protected addAction(name: string, fn: (item: ListItem, context: ListContext) => ProviderResult<void>, options?: ActionOptions): void {
    this.createAction(Object.assign({
      name,
      execute: fn
    } as any, options || {}))
  }

  protected addMultipleAction(name: string, fn: (item: ListItem[], context: ListContext) => ProviderResult<void>, options?: ActionOptions): void {
    this.createAction(Object.assign({
      name,
      multiple: true,
      execute: fn
    }, options || {}))
  }

  protected createCommandTask(opt: CommandTaskOption): CommandTask {
    return new CommandTask(opt)
  }

  public addLocationActions(): void {
    this.createAction({
      name: 'preview',
      execute: async (item: ListItem, context: ListContext) => {
        let loc = await this.convertLocation(item.location)
        await this.previewLocation(loc, context)
      }
    })
    let { nvim } = this
    this.createAction({
      name: 'quickfix',
      multiple: true,
      execute: async (items: ListItem[]) => {
        let quickfixItems = await Promise.all(items.map(item => this.convertLocation(item.location).then(loc => workspace.getQuickfixItem(loc))))
        await nvim.call('setqflist', [quickfixItems])
        let openCommand = await nvim.getVar('coc_quickfix_open_command') as string
        nvim.command(typeof openCommand === 'string' ? openCommand : 'copen', true)
      }
    })
    for (let name of ['open', 'tabe', 'drop', 'vsplit', 'split']) {
      this.createAction({
        name,
        execute: async (item: ListItem, context: ListContext) => {
          await this.jumpTo(item.location, name == 'open' ? null : name, context)
        },
        tabPersist: name === 'open'
      })
    }
  }

  public async convertLocation(location: LocationWithTarget | LocationWithLine | string): Promise<LocationWithTarget> {
    if (typeof location == 'string') return Location.create(location, Range.create(0, 0, 0, 0))
    if (Location.is(location)) return location
    let u = URI.parse(location.uri)
    if (u.scheme != 'file') return Location.create(location.uri, Range.create(0, 0, 0, 0))
    return await lineToLocation(u.fsPath, location.line, location.text)
  }

  public async jumpTo(location: Location | LocationWithLine | string, command?: string, context?: ListContext): Promise<void> {
    if (command == null && context && context.options.position === 'tab') {
      command = 'tabe'
    }
    if (typeof location == 'string') {
      await workspace.jumpTo(location, null, command)
      return
    }
    let { range, uri } = await this.convertLocation(location)
    let position = range.start
    if (position.line == 0 && position.character == 0 && comparePosition(position, range.end) == 0) {
      // allow plugin that remember position.
      position = null
    }
    await workspace.jumpTo(uri, position, command)
  }

  public createAction(action: SingleListAction | MultipleListAction): void {
    let { name } = action
    let idx = this.actions.findIndex(o => o.name == name)
    // allow override
    if (idx !== -1) this.actions.splice(idx, 1)
    this.actions.push(action)
  }

  protected async previewLocation(location: LocationWithTarget, context: ListContext): Promise<void> {
    let { nvim } = this
    let { uri, range } = location
    let doc = workspace.getDocument(location.uri)
    let u = URI.parse(uri)
    let lines = await workspace.documentsManager.getLines(uri)
    let config: PreviewConfig = {
      winid: context.window.id,
      range: emptyRange(range) ? null : range,
      lnum: range.start.line + 1,
      name: u.scheme == 'file' ? u.fsPath : uri,
      filetype: toVimFiletype(doc ? doc.languageId : workspace.documentsManager.getLanguageId(u.fsPath)),
      position: context.options.position,
      maxHeight: this.previewHeight,
      splitRight: this.splitRight,
      hlGroup: this.hlGroup,
      scheme: u.scheme,
      toplineStyle: this.toplineStyle,
      toplineOffset: this.toplineOffset,
      targetRange: location.targetRange
    }
    await nvim.call('coc#list#preview', [lines, config])
  }

  public async preview(options: PreviewOptions, context: ListContext): Promise<void> {
    let { nvim } = this
    let { bufname, filetype, range, lines, lnum } = options
    let config: PreviewConfig = {
      winid: context.window.id,
      lnum: range ? range.start.line + 1 : lnum || 1,
      filetype,
      position: context.options.position,
      maxHeight: this.previewHeight,
      splitRight: this.splitRight,
      hlGroup: this.hlGroup,
      toplineStyle: this.toplineStyle,
      toplineOffset: this.toplineOffset,
    }
    if (bufname) config.name = bufname
    if (range) config.range = range
    await nvim.call('coc#list#preview', [lines, config])
    nvim.command('redraw', true)
  }

  public abstract loadItems(context: ListContext, token?: CancellationToken): Promise<ListItem[] | ListTask | null | undefined>

  public doHighlight(): void {
    // noop
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}

export function toVimFiletype(filetype: string): string {
  switch (filetype) {
    case 'latex':
      // LaTeX (LSP language ID 'latex') has Vim filetype 'tex'
      return 'tex'
    default:
      return filetype
  }
}
