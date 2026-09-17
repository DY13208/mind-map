<template>
  <div class="sopPage" :class="{ detailMode: detailMode }">
    <header class="sopHeader" v-if="!detailMode">
      <div class="left">
        <el-button size="small" class="openMapBtn" @click="goBack">
          <SopGlyph kind="map" size="md" />
          <span>{{ headerBackLabel }}</span>
        </el-button>
        <div class="titleBlock">
          <h1>SOP 台账</h1>
          <p class="titleSub" v-if="statusText">{{ statusText }}</p>
        </div>
      </div>
      <div class="right">
        <span class="spaceLabel">目录</span>
        <el-popover
          v-model="spaceDirectoryVisible"
          placement="bottom-end"
          width="600"
          trigger="click"
          popper-class="sopSpaceDirectoryDropdown"
          @show="syncSpaceDirectoryTree"
        >
          <div class="spaceDirectoryPicker" @keydown.esc.stop="spaceDirectoryVisible = false">
            <el-input
              v-model="spaceDirectoryQuery"
              size="small"
              clearable
              prefix-icon="el-icon-search"
              placeholder="搜索文件夹或脑图（脑图搜索最多显示 100 条）"
              aria-label="搜索文件夹或脑图"
            ></el-input>
            <div v-if="spacesLoading" class="spaceDirectoryLoading">
              正在加载目录…
            </div>
            <el-tree
              v-else
              ref="spaceDirectoryTree"
              class="spaceDirectoryTree"
              :data="spaceDirectoryOptions"
              node-key="value"
              :props="spaceDirectoryTreeProps"
              lazy
              :load="loadSpaceDirectoryNode"
              :filter-node-method="filterSpaceDirectoryNode"
              :expand-on-click-node="false"
              :highlight-current="true"
              empty-text="没有可访问的脑图"
              @node-click="onSpaceDirectoryNodeClick"
            >
              <span
                slot-scope="{ data }"
                :class="['spaceDirectoryOption', `spaceDirectoryOption--${data.kind}`]"
                :title="spaceDirectoryOptionTitle(data)"
              >
                <i
                  v-if="data.kind !== 'more'"
                  :class="
                    data.kind === 'space'
                      ? data.spaceType === 'personal'
                        ? 'el-icon-user'
                        : 'el-icon-office-building'
                      : data.kind === 'folder'
                        ? 'el-icon-folder-opened'
                      : data.kind === 'more'
                        ? 'el-icon-more'
                        : 'el-icon-document'
                  "
                  aria-hidden="true"
                ></i>
                <span class="spaceDirectoryName">{{ data.label }}</span>
                <span v-if="data.kind === 'folder' || (data.kind === 'space' && data.roomCount != null)" class="spaceDirectoryMeta">
                  {{ data.roomCount }} 个脑图
                </span>
                <span v-else-if="data.kind !== 'space'" class="spaceDirectoryMeta">
                  {{ data.accessLabel }}<template v-if="data.ownerName"> · {{ data.ownerName }}</template>
                </span>
              </span>
            </el-tree>
          </div>
          <el-button
            slot="reference"
            size="small"
            class="spaceSelect"
            :class="{ isOpen: spaceDirectoryVisible }"
            :loading="spacesLoading"
            :disabled="spacesLoading"
            aria-haspopup="tree"
            :aria-expanded="String(spaceDirectoryVisible)"
          >
            <i class="el-icon-folder-opened" aria-hidden="true"></i>
            <span class="spaceSelectText">{{ selectedSpaceDirectoryLabel }}</span>
            <i class="el-icon-arrow-down spaceSelectCaret" aria-hidden="true"></i>
          </el-button>
        </el-popover>
        <el-button
          size="small"
          type="primary"
          class="refreshBtn"
          :loading="pullLoading"
          :disabled="!roomKey"
          @click="refreshRoomList"
        >
          <SopGlyph v-if="!pullLoading" kind="refresh" size="sm" />
          <span>刷新</span>
        </el-button>
      </div>
    </header>
    <header class="sopHeader" v-else>
      <div class="left">
        <el-button size="small" class="openMapBtn" @click="goBack">
          {{ headerBackLabel }}
        </el-button>
        <h1 class="detailTitle">
          {{ (activeSop && activeSop.title) || dialogTitle || 'SOP 详情' }}
        </h1>
      </div>
      <div class="right">
        <el-button
          size="small"
          type="primary"
          class="refreshBtn"
          :disabled="!activeSop || !canEditSop"
          @click="openRunDialog(activeSop)"
        >
          <SopGlyph kind="play" size="sm" />
          <span>运行</span>
        </el-button>
        <el-button size="small" :loading="subtreeLoading" @click="reloadDetail">
          刷新导图
        </el-button>
      </div>
    </header>

    <template v-if="!detailMode">
      <div class="statusLine runStatus" v-if="sopQueueSummary">
        {{ sopQueueSummary }}
      </div>
      <div class="statusLine viewerHint" v-if="roomKey && roomRole && !canEditSop">
        当前为只读权限（{{ roomRole }}）：可查看与搜索，无法运行或保存台账
      </div>

      <div v-if="!roomKey" class="emptyState">请先选择空间</div>
      <div v-else class="sopWorkspace">
        <div class="sopSearchWrap">
          <SopGlyph kind="search" size="md" class="searchGlyph" />
          <el-input
            v-model="sopSearchQuery"
            size="medium"
            clearable
            placeholder="搜索当前脑图 SOP 标题或路径"
            class="sopSearch"
            @input="onSopSearchInput"
          />
        </div>
        <div
          v-if="sopSearchQuery.trim() && !visibleSops.length"
          class="emptyState searchEmpty"
        >
          未找到「{{ sopSearchQuery.trim() }}」相关 SOP
          <el-button type="text" @click="clearSopSearch">清空搜索</el-button>
        </div>
        <div v-else-if="!pullLoading && !sops.length" class="emptyState">
          该空间未找到 SOP
        </div>
        <div
          v-else
          class="sopSplit"
          :class="{ treeCollapsed: treePaneCollapsed }"
        >
          <aside
            v-show="!treePaneCollapsed"
            class="sopTreePane"
            tabindex="0"
            @keydown="onTreeKeydown"
          >
            <div class="treeHead">
              <span>脑图层级</span>
              <button
                type="button"
                class="treeCollapseBtn"
                title="收起脑图层级"
                aria-label="收起脑图层级"
                aria-expanded="true"
                @click.stop="toggleTreePane"
              >
                <SopGlyph kind="panel-collapse" size="sm" />
              </button>
            </div>
            <ul class="sopTree" role="tree">
              <SopTreeNode
                v-for="node in visibleTreeRoots"
                :key="node.uid"
                :node="node"
                :depth="0"
                :selected-uid="selectedTreeUid"
                :expanded-map="treeExpanded"
                :highlight="sopSearchNorm"
                @toggle="toggleTreeNode"
                @select="selectTreeNode"
              />
            </ul>
          </aside>
          <section class="sopCardPane">
            <div class="cardPaneHead">
              <div class="branchHeadLeft">
                <button
                  v-if="treePaneCollapsed"
                  type="button"
                  class="treeCollapseBtn"
                  title="展开脑图层级"
                  aria-label="展开脑图层级"
                  aria-expanded="false"
                  @click.stop="toggleTreePane"
                >
                  <SopGlyph kind="panel-expand" size="sm" />
                </button>
                <span class="branchLabel">{{ branchCardsLabel }}</span>
              </div>
              <div class="viewToggle">
                <button
                  type="button"
                  class="viewBtn"
                  :class="{ active: branchViewMode === 'card' }"
                  @click="branchViewMode = 'card'"
                >
                  <SopGlyph kind="cards" size="sm" />
                  <span>按卡片</span>
                </button>
                <button
                  type="button"
                  class="viewBtn"
                  :class="{ active: branchViewMode === 'list' }"
                  @click="branchViewMode = 'list'"
                >
                  <SopGlyph kind="list" size="sm" />
                  <span>按列表</span>
                </button>
              </div>
            </div>

            <div v-if="!branchCards.length" class="paneEmpty soft">
              该分支下没有 D 阶段 SOP
            </div>

            <div v-else-if="branchViewMode === 'card'" class="dCardStack">
              <article
                v-for="item in branchCards"
                :key="item.rowKey || item.uid"
                class="dCard green"
                :class="{ collapsed: cardCollapsed[item.uid] }"
                title="双击打开详情"
                @dblclick="openSubtree(item)"
              >
                <div class="dCardTop">
                  <div class="dCardIcon green">
                    <SopGlyph kind="D" size="xl" />
                  </div>
                  <div class="dCardMain">
                    <div class="dCardTitleRow">
                      <h2
                        class="dCardTitle"
                        v-html="highlightText(item.displayTitle || item.title, sopSearchNorm)"
                      ></h2>
                      <span
                        v-if="(item.subtasks || []).length"
                        class="autoRunTip"
                      >
                        运行父任务将自动执行 {{ item.subtasks.length }} 个子任务
                        <SopGlyph kind="info" size="sm" />
                      </span>
                    </div>
                    <div
                      class="dCardPath"
                      :title="sopBreadcrumb(item)"
                      v-html="highlightText(sopFullPath(item), sopSearchNorm)"
                    ></div>
                    <div class="dCardMeta">
                      <span class="metaChip accent">子任务 {{ (item.subtasks || []).length }}</span>
                      <span class="metaChip">运行 {{ sopRunCount(item) }}次</span>
                      <span class="metaChip">产物 {{ sopDeliverableCount(item) }}个</span>
                      <span class="metaChip">{{ sopSuccessRateLabel(item) }}</span>
                    </div>
                  </div>
                  <div class="dCardActions">
                    <span
                      v-if="sopCardJobState(item)"
                      class="jobChip"
                      :class="sopCardJobState(item)"
                      >{{ sopCardJobLabel(item) }}</span
                    >
                    <button
                      type="button"
                      class="runBtn primary"
                      @click.stop="openSubtree(item)"
                    >
                      <span>打开</span>
                      <SopGlyph kind="chevron-right" size="sm" class="runCaret" />
                    </button>
                    <button
                      v-if="(item.subtasks || []).length"
                      type="button"
                      class="collapseBtn"
                      :title="cardCollapsed[item.uid] ? '展开子任务' : '收起子任务'"
                      @click.stop="toggleCardCollapse(item.uid)"
                    >
                      <SopGlyph
                        :kind="cardCollapsed[item.uid] ? 'chevron-down' : 'chevron-up'"
                        size="md"
                      />
                    </button>
                  </div>
                </div>

                <div
                  v-if="(item.subtasks || []).length && !cardCollapsed[item.uid]"
                  class="subtaskList"
                >
                  <div
                    class="subtaskRow"
                    v-for="(sub, sIdx) in item.subtasks"
                    :key="sub.uid || sub.rowKey"
                    :class="{ last: sIdx === item.subtasks.length - 1 }"
                    title="双击打开详情"
                    @dblclick.stop="openSubtree(sub)"
                  >
                    <div class="subRail" aria-hidden="true"></div>
                    <div class="subIcon">
                      <SopGlyph
                        :kind="subtaskGlyphKind(sub)"
                        size="md"
                      />
                    </div>
                    <div class="subMain">
                      <div
                        class="subTitle"
                        v-html="
                          highlightText(
                            formatSubtaskTitle(sub),
                            sopSearchNorm
                          )
                        "
                      ></div>
                      <div class="subDesc">{{ subtaskDesc(sub) }}</div>
                    </div>
                    <div class="subMeta">
                      <span class="subState" :class="subtaskStateClass(sub)">
                        <span class="dot"></span>{{ subtaskStateLabel(sub) }}
                      </span>
                      <span class="subStat">产物 {{ sopDeliverableCount(sub) }}</span>
                      <span class="subStat">更新时间 {{ subtaskUpdatedAt(sub) }}</span>
                    </div>
                    <div class="subActions">
                      <button type="button" class="linkBtn" @click.stop="openSubtree(sub)">
                        查看详情
                      </button>
                      <button type="button" class="linkBtn" @click.stop="locateSopInMap(sub)">
                        定位脑图
                      </button>
                      <el-dropdown
                        trigger="click"
                        @command="cmd => onSubtaskMenu(cmd, sub, item)"
                      >
                        <button type="button" class="moreBtn" @click.stop>
                          <SopGlyph kind="more" size="md" />
                        </button>
                        <el-dropdown-menu slot="dropdown">
                          <el-dropdown-item command="detail">查看详情</el-dropdown-item>
                          <el-dropdown-item command="locate">定位脑图</el-dropdown-item>
                        </el-dropdown-menu>
                      </el-dropdown>
                    </div>
                  </div>
                </div>

                <div v-else-if="!(item.subtasks || []).length" class="dCardFooter">
                  <button type="button" class="linkBtn" @click.stop="openSubtree(item)">
                    查看详情
                  </button>
                  <button type="button" class="linkBtn" @click.stop="locateSopInMap(item)">
                    定位脑图
                  </button>
                </div>
              </article>
            </div>

            <div v-else class="dListStack">
              <div
                class="dListGroup"
                v-for="item in branchCards"
                :key="'list-' + (item.rowKey || item.uid)"
              >
                <div
                  class="dListParent"
                  title="双击打开详情"
                  @dblclick="openSubtree(item)"
                >
                  <div class="dCardIcon sm green">
                    <SopGlyph kind="D" size="lg" />
                  </div>
                  <div class="listMain">
                    <div
                      class="listTitle"
                      v-html="highlightText(item.displayTitle || item.title, sopSearchNorm)"
                    ></div>
                    <div class="listPath">{{ sopFullPath(item) }}</div>
                  </div>
                  <div class="listMeta">
                    <span>子任务 {{ (item.subtasks || []).length }}</span>
                    <span>运行 {{ sopRunCount(item) }}次</span>
                    <span>产物 {{ sopDeliverableCount(item) }}个</span>
                  </div>
                  <div class="listActions">
                    <button type="button" class="linkBtn" @click.stop="openSubtree(item)">
                      查看详情
                    </button>
                    <button type="button" class="linkBtn" @click.stop="locateSopInMap(item)">
                      定位脑图
                    </button>
                    <button
                      type="button"
                      class="runBtn primary"
                      @click.stop="openSubtree(item)"
                    >
                      <span>打开</span>
                      <SopGlyph kind="chevron-right" size="sm" class="runCaret" />
                    </button>
                  </div>
                </div>
                <div
                  class="dListChild"
                  v-for="sub in item.subtasks || []"
                  :key="'list-sub-' + (sub.uid || sub.rowKey)"
                  title="双击打开详情"
                  @dblclick.stop="openSubtree(sub)"
                >
                  <div class="subIcon">
                    <SopGlyph :kind="subtaskGlyphKind(sub)" size="md" />
                  </div>
                  <div class="listMain">
                    <div
                      class="listTitle sub"
                      v-html="highlightText(formatSubtaskTitle(sub), sopSearchNorm)"
                    ></div>
                    <div class="listPath">{{ subtaskDesc(sub) }}</div>
                  </div>
                  <div class="listMeta">
                    <span class="subState" :class="subtaskStateClass(sub)">
                      <span class="dot"></span>{{ subtaskStateLabel(sub) }}
                    </span>
                    <span>产物 {{ sopDeliverableCount(sub) }}</span>
                    <span>{{ subtaskUpdatedAt(sub) }}</span>
                  </div>
                  <div class="listActions">
                    <button type="button" class="linkBtn" @click.stop="openSubtree(sub)">
                      查看详情
                    </button>
                    <button type="button" class="linkBtn" @click.stop="locateSopInMap(sub)">
                      定位脑图
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </template>

    <div class="sopDetailPage" v-else>
      <el-tabs v-model="dialogTab" class="detailTabs">
        <el-tab-pane label="记录" name="runs">
          <div class="historyPane">
            <SopTaskBoard
              v-if="detailSopTaskJobs.length"
              embedded
              title="SOP 任务"
              :jobs="detailSopTaskJobs"
              :selected-id="selectedSopJobId"
              @select="selectSopJob"
              @cancel="cancelSopJob"
              @cancel-all="cancelAllSopJobs"
              @resume="resumeSopJob"
              @artifact-optimized="onArtifactOptimized"
              @continue-partial="continuePartialSopJob"
            />
            <div v-else class="paneEmpty soft">暂无任务</div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="导图" name="map">
          <div class="syncBar">
            <span class="syncDot" :class="syncStatus"></span>
            <span>{{ syncLabel }}</span>
            <span class="syncTip">编辑会同步到房间；导图页也会收到更新</span>
          </div>
          <div class="mindWrap" v-loading="subtreeLoading">
            <div v-if="subtreeError" class="emptyState">{{ subtreeError }}</div>
            <div
              v-show="!subtreeError"
              ref="mindMapContainer"
              class="mindMapContainer"
            ></div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog
      v-if="false"
      title="运行 SOP"
      :visible.sync="runDialogVisible"
      width="744px"
      top="8vh"
      append-to-body
      :close-on-click-modal="false"
      custom-class="sopRunDialog"
    >
      <p class="runDialogLead" v-if="runTarget">
        将任务加入队列后可在后台并行执行；你可以关闭本窗口，稍后在 SOP 台账详情的「记录」中查看进度。
      </p>
      <section class="runExecutionPanel">
        <h3>执行配置</h3>
        <div class="runExecutionMain">
          <label class="runExecutionField runEngineField">
            <span>执行引擎</span>
            <el-select v-model="runBackend" size="small" @change="onRunBackendChange">
              <el-option label="WorkBuddy" :value="AI_BACKEND_WORKBUDDY"></el-option>
              <el-option label="小策" :value="AI_BACKEND_XIAOCE"></el-option>
              <el-option label="助理" :value="AI_BACKEND_OPENCLAW"></el-option>
            </el-select>
          </label>
          <template v-if="runBackend === AI_BACKEND_OPENCLAW">
            <label class="runExecutionField runModelField">
              <span>模型</span>
              <el-select v-model="runModel" size="small" filterable allow-create default-first-option :loading="runModelsLoading" placeholder="选择助理模型" @visible-change="onRunModelDropdown">
                <el-option v-for="item in runOpenclawModels" :key="'oc-' + item.id" :label="item.name || item.id" :value="item.id"></el-option>
              </el-select>
            </label>
            <el-button class="runRefreshButton" size="small" icon="el-icon-refresh" :loading="runModelsLoading" @click="loadRunModels(true)">刷新</el-button>
          </template>
          <template v-else-if="runBackend === AI_BACKEND_WORKBUDDY">
            <label class="runExecutionField runModelField">
              <span>模型</span>
              <el-select v-model="runModel" size="small" filterable :loading="runModelsLoading" placeholder="选择 WorkBuddy 模型" @visible-change="onRunModelDropdown">
                <el-option-group v-if="runCustomModels.length" label="自定义模型（推荐，不耗积分）">
                  <el-option v-for="item in runCustomModels" :key="'c-' + item.id" :label="item.name || item.id" :value="item.id"></el-option>
                </el-option-group>
                <el-option-group v-if="runPlatformModels.length" label="平台模型">
                  <el-option v-for="item in runPlatformModels" :key="'p-' + item.id" :label="item.name || item.id" :value="item.id"></el-option>
                </el-option-group>
              </el-select>
            </label>
            <el-button class="runRefreshButton" size="small" icon="el-icon-refresh" :loading="runModelsLoading" @click="loadRunModels(true)">刷新</el-button>
          </template>
        </div>
        <div v-if="runBackend === AI_BACKEND_XIAOCE" class="runExecutionScope">
          <label class="runExecutionField">
            <span>企业</span>
            <el-select v-model="runOrganizationId" size="small" :loading="runScopeLoading" placeholder="选择企业" @change="onRunOrganizationChange">
              <el-option v-for="item in runOrganizations" :key="item.id" :label="item.name" :value="String(item.id)"></el-option>
            </el-select>
          </label>
          <label class="runExecutionField">
            <span>智能体</span>
            <el-select v-model="runAgentId" size="small" :loading="runScopeLoading" placeholder="选择智能体">
              <el-option v-for="item in runAgents" :key="item.id" :label="`${item.emoji || '🤖'} ${item.name}`" :value="String(item.id)"></el-option>
            </el-select>
          </label>
          <el-button class="runRefreshButton" size="small" icon="el-icon-refresh" :loading="runScopeLoading" @click="loadRunXiaoceScope(true)">刷新</el-button>
        </div>
      </section>
      <div class="runSectionTitle"><strong>输出内容</strong><span>可不选</span></div>
      <el-checkbox-group v-model="runOutputIds" class="outputChecks">
        <el-checkbox
          v-for="opt in outputPresets"
          :key="opt.id"
          :label="opt.id"
          class="outputCheck"
        >
          <span class="optLabel">{{ opt.label }}</span>
        </el-checkbox>
      </el-checkbox-group>
      <p class="runOutputRulesTip">
        运行会按内置「输出规则」写业务可读汇报（结论 / 交付 / 发现 / 改脑图建议）；勾选类别仅在规则表已定义时强制版式。
        <a :href="outputRulesUrls.xmind" download="SOP输出规则.xmind">下载规则脑图</a>
        <button type="button" class="runOutputRulesLink" :disabled="cloningOutputRules" @click="cloneOutputRulesMap">
          {{ cloningOutputRules ? '正在复制…' : '复制到我的空间' }}
        </button>
      </p>
      <div v-if="runSubmitLoading" class="runSubmitLoading">正在读取资料模板…</div>
      <div
        class="runSubmitBox"
        v-else-if="runSubmitFields.length"
      >
        <div class="runSubmitHead">
          <strong>先填写资料再执行</strong>
          <span v-if="runSubmitZoneHint">{{ runSubmitZoneHint }}</span>
        </div>
        <p class="runSubmitTip">
          检测到「提交资料 / 提供」类节点，请按模板填写；内容会随任务一并交给执行助手。
        </p>
        <div class="runSubmitGrid">
          <div
            class="runSubmitField"
            v-for="f in runSubmitFields"
            :key="f.key"
          >
            <label>{{ f.label }}</label>
            <el-input
              v-model="f.value"
              size="small"
              clearable
              :placeholder="f.hint || '请填写'"
            ></el-input>
          </div>
        </div>
      </div>
      <div class="runSectionTitle runComposeTitle"><strong>附件与补充说明</strong></div>
      <div class="runComposeBox" @paste="onRunPaste">
        <input ref="runAttachmentInput" class="runAttachmentInput" type="file" multiple
          :accept="SOP_ATTACHMENT_ACCEPT" @change="onRunFilesPicked" />
        <input ref="runImageInput" class="runAttachmentInput" type="file" multiple accept="image/*" @change="onRunFilesPicked" />
        <el-input
          ref="runNoteInput"
          v-model="runExtraNote"
          type="textarea"
          :rows="3"
          placeholder="可输入补充要求，也可直接粘贴文本、截图或文件"
          aria-label="附件与补充说明"
          class="runExtra"
        ></el-input>
        <span v-if="!runExtraNote" class="runComposeExample">例如：给黄炜龙发个代办；或：我要招聘一个初级客服</span>
        <div class="runComposeToolbar">
          <div class="runPasteIcons">
            <button type="button" title="上传图片" aria-label="上传图片" @click="$refs.runImageInput.click()"><i class="el-icon-picture-outline"></i></button>
            <button type="button" title="上传文件" aria-label="上传文件" @click="$refs.runAttachmentInput.click()"><i class="el-icon-document"></i></button>
            <button type="button" title="聚焦输入框，可使用 Ctrl+V 粘贴截图或文件" aria-label="聚焦输入框以粘贴" @click="$refs.runNoteInput.focus()"><i class="el-icon-full-screen"></i></button>
          </div>
          <span class="runPasteHint">支持直接粘贴图片或文件（Ctrl+V）</span>
          <span class="runNoteCount" aria-label="已输入字数">{{ runExtraNote.length }} 字</span>
        </div>
      </div>
      <div v-if="runAttachments.length" class="runAttachmentList" aria-live="polite">
        <span v-for="file in runAttachments" :key="file.key" class="runAttachmentTag"
          :class="{ 'is-failed': file.status === 'failed' }" :title="file.error || file.name">
          <i v-if="file.status === 'uploading'" class="el-icon-loading" aria-label="正在上传并解析"></i>
          <i v-else-if="file.status === 'failed'" class="el-icon-warning-outline"></i>
          <span v-else class="runFileBadge" :class="'runFileBadge--' + file.kind">{{ file.badge }}</span>
          <span class="runFileName">{{ file.name }}</span>
          <span v-if="file.status === 'failed'" class="runFileError">解析失败</span>
          <button type="button" :aria-label="'删除附件 ' + file.name" @click="removeRunAttachment(file)"><i class="el-icon-close"></i></button>
        </span>
      </div>
      <p class="runAttachmentTip">支持 PDF、Word、Excel、文本、图片，单个不超过 5 MB，最多 5 个。</p>
      <span slot="footer" class="runDialogFooter">
        <el-button size="small" @click="runDialogVisible = false"
          >取消</el-button
        >
        <el-button
          type="primary"
          size="small"
          :loading="runSubmitLoading"
          :disabled="runAttachments.some(file => file.status !== 'ready')"
          @click="confirmRunSop"
        >
          加入队列并开始
        </el-button>
      </span>
    </el-dialog>

    <SopRunDialog
      :visible.sync="runDialogVisible"
      :room-key="roomKey"
      :target="runTarget"
      :actor="userInfo.name || '台账'"
      @enqueued="onSharedRunEnqueued"
      @finished="onSharedRunFinished"
      @waiting="onSharedRunWaiting"
    />

  </div>
</template>

<script>
import { mapMutations } from 'vuex'
import { io } from 'socket.io-client'
import MindMap from 'simple-mind-map'
import Drag from 'simple-mind-map/src/plugins/Drag.js'
import Select from 'simple-mind-map/src/plugins/Select.js'
import TouchEvent from 'simple-mind-map/src/plugins/TouchEvent.js'
import Cooperate from 'simple-mind-map/src/plugins/Cooperate.js'
import exampleData from 'simple-mind-map/example/exampleData'
import { createCollaborationAdapter } from 'simple-mind-map/bin/collabV2/adapter'
import { getLocalConfig } from '@/api'
import { SOP_ATTACHMENT_ACCEPT, SOP_ATTACHMENT_LIMIT, validateSopAttachment, uploadSopAttachment, formatSopAttachmentNote } from '@/utils/sopRunAttachments'
import { getCurrentUser } from '@/utils/auth'
import { roomFromLocation } from '@/utils/roomLocation'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
import teamService from '@/services/teamService'
import {
  listFiles,
  getFileSubtree,
  getFileExport,
  getFileNodes,
  locateFileNode,
  getMapOperations,
  getMapVersion,
  addFileNode,
  patchFileNode,
  deleteFileNode,
  replaceFileTree,
  undoMapOperation,
  redoMapOperation,
  searchLocalArtifacts,
  authorizeSopRun
} from '@/utils/fileApi'
import folderService from '@/services/folderService'
import {
  listRoomDRegistrySops,
  fillDefaultCpda,
  buildSopHierarchyTree,
  filterSopsBySearch,
  filterHierarchyTreeForSearch,
  normalizeSopSearchQuery,
  groupSopsIntoCards,
  attachFallbackSubtasks,
  formatSubtaskDisplayTitle,
  formatSopDisplayTitle
} from '@/utils/sopRegistryPrompt'
import {
  normalizeLedger,
  mergeLedgerSources,
  latestDeliverableText,
  addDeliverableToLedger,
  persistSopLedger,
  readLedgerFromNodeLike
} from '@/utils/sopLedger'
import {
  SOP_OUTPUT_PRESETS,
  extractDeliverablesFromReply,
  loadSopRunContext
} from '@/utils/sopRun'
import {
  getSopOutputRulesTemplateUrls,
  cloneSopOutputRulesTemplate
} from '@/utils/sopOutputRulesTemplate'
import {
  assessNoHyperlinkContinuity,
  formatContinuityExtraNote
} from '@/utils/sopFlowContinuity'
import {
  getSharedSopRunQueue,
  resolveSopRunConcurrency
} from '@/utils/sopRunQueue'
import { areWaitingWecomTodosDone } from '@/utils/sopNotify'
import {
  extractSubmitMaterialFields,
  formatSubmitMaterialNote,
  missingSubmitMaterialLabels
} from '@/utils/sopSubmitMaterial'
import {
  fetchAiModels,
  fetchWorkbuddyModels,
  getWorkbuddyConfig,
  getOpenclawConfig,
  saveOpenclawConfig,
  WORKBUDDY_CUSTOM_MODEL_HINTS,
  fetchXiaoceOrganizations,
  fetchXiaoceAgents,
  AI_BACKEND_XIAOCE,
  AI_BACKEND_OPENCLAW,
  normalizeAiBackend
} from '@/utils/agentChat'
import SopTaskBoard from './components/SopTaskBoard.vue'
import SopTreeNode from './components/SopTreeNode.vue'
import SopGlyph from './components/SopGlyph.vue'
import SopRunDialog from './components/SopRunDialog.vue'

MindMap.usePlugin(Drag)
  .usePlugin(Select)
  .usePlugin(TouchEvent)
  .usePlugin(Cooperate)

const V2_CLIENT_KEY = 'mind-map-collab-v2-client'

function tabClientId() {
  try {
    let id = sessionStorage.getItem(V2_CLIENT_KEY)
    if (!id || !String(id).trim()) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      sessionStorage.setItem(V2_CLIENT_KEY, id)
    }
    return String(id).trim()
  } catch (e) {
    return `c_${Date.now()}`
  }
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function toMindMapTree(tree, depth = 0) {
  if (!tree) return null
  const data = (tree && tree.data) || {}
  const uid = data.uid || tree.uid || ''
  const rawText = stripHtml(data.text || tree.text || '')
  const note = data.note || tree.note || ''
  const children = (tree.children || [])
    .map(child => toMindMapTree(child, depth + 1))
    .filter(Boolean)
  return {
    data: {
      ...data,
      text: rawText || '(空)',
      // 仅展开浅层，避免详情页一次全展开布局卡顿
      expand: depth < 2,
      ...(uid ? { uid } : {}),
      ...(note ? { note: String(note) } : {}),
      ...(data.sopLedger ? { sopLedger: data.sopLedger } : {})
    },
    children
  }
}

export default {
  name: 'SopRegistryPage',
  components: { SopTaskBoard, SopTreeNode, SopGlyph, SopRunDialog },
  data() {
    return {
      sops: [],
      flatNodes: [],
      treeRoots: [],
      treeExpanded: {},
      treePaneCollapsed: false,
      selectedTreeUid: '',
      sopSearchQuery: '',
      branchViewMode: 'card',
      cardCollapsed: {},
      roomRole: null,
      canEditSop: false,
      canManageSop: false,
      statusText: '',
      pullLoading: false,
      spacesLoading: false,
      roomKey: '',
      spaceOptions: [],
      folders: [],
      ungroupedRoomCount: 0,
      teamSpaces: [],
      spaceDirectorySearchResults: [],
      spaceDirectorySearchLoading: false,
      spaceDirectorySearchTimer: null,
      spaceDirectorySearchRequestId: 0,
      spaceDirectoryVisible: false,
      spaceDirectoryQuery: '',
      spaceDirectoryTreeProps: {
        children: 'children',
        label: 'label',
        isLeaf: 'isLeaf'
      },
      dialogVisible: false,
      dialogTitle: '',
      dialogTab: 'runs',
      activeSop: null,
      activeSopUid: '',
      activeLedger: {
        frequency: { label: '未知', cron_hint: null },
        runs: [],
        deliverables: []
      },
      scannedDeliverables: [],
      outputPresets: SOP_OUTPUT_PRESETS,
      outputRulesUrls: getSopOutputRulesTemplateUrls(),
      cloningOutputRules: false,
      runDialogVisible: false,
      runTarget: null,
      runOutputIds: [],
      runExtraNote: '',
      runContinuityNote: '',
      runAttachments: [],
      SOP_ATTACHMENT_ACCEPT,
      runSubmitFields: [],
      runSubmitZones: [],
      runSubmitLoading: false,
      runSubmitSource: '',
      runModel: 'openclaw/default',
      runBackend: 'openclaw',
      runOrganizationId: '',
      runAgentId: '',
      runOrganizations: [],
      runAgents: [],
      runScopeLoading: false,
      AI_BACKEND_WORKBUDDY: 'workbuddy',
      AI_BACKEND_XIAOCE: 'xiaoce',
      AI_BACKEND_OPENCLAW: 'openclaw',
      runModelsLoading: false,
      runCustomModels: WORKBUDDY_CUSTOM_MODEL_HINTS.slice(),
      runOpenclawModels: [
        { id: 'openclaw/default', name: 'openclaw/default' }
      ],
      runPlatformModels: [],
      sopRunQueue: null,
      sopQueueSnap: {
        pending: [],
        running: [],
        waiting: [],
        recent: [],
        queuedCount: 0,
        runningCount: 0,
        waitingCount: 0,
        total: 0,
        concurrency: 2
      },
      selectedSopJobId: '',
      subtreeLoading: false,
      subtreeError: '',
      pendingRoot: null,
      pendingVersion: 0,
      previewMindMap: null,
      collabV2Adapter: null,
      syncStatus: 'idle'
    }
  },
  computed: {
    syncLabel() {
      if (this.subtreeLoading) return '加载中…'
      if (this.syncStatus === 'live') return '已协同同步'
      if (this.syncStatus === 'connecting') return '正在连接协同…'
      if (this.syncStatus === 'error') return '协同异常（本地仍可改）'
      return '未连接协同'
    },
    userInfo() {
      const user = getCurrentUser() || {}
      return {
        id: String(user.id || user.userId || 'local').replace(/^wecom:/, ''),
        name: user.name || '用户',
        color: user.color || '#409EFF'
      }
    },
    spaceDirectoryOptions() {
      if (this.spaceDirectoryQuery) {
        return [
          {
            value: 'folder:search-results',
            label: this.spaceDirectorySearchLoading ? '正在搜索…' : '搜索结果',
            kind: 'search',
            isLeaf: !this.spaceDirectorySearchResults.length,
            children: this.spaceDirectorySearchResults
          }
        ]
      }
      return this.buildSpaceDirectoryOptions()
    },
    selectedSpaceDirectoryLabel() {
      const room = String(this.roomKey || '').trim()
      if (!room) return '选择文件夹 / 脑图'
      const path = this.findSpaceDirectoryPath(room)
      if (path.length) return path.map(item => item.label).join(' / ')
      return room
    },
    sopQueueSummary() {
      const s = this.sopQueueSnap || {}
      if (!s.total && !(s.recent && s.recent.length)) return ''
      return `执行 ${s.runningCount || 0} · 等待 ${s.waitingCount || 0} · 排队 ${
        s.queuedCount || 0
      } · 并发 ${s.concurrency || 2}`
    },
    sopSearchNorm() {
      return normalizeSopSearchQuery(this.sopSearchQuery)
    },
    visibleSops() {
      return filterSopsBySearch(this.sops, this.sopSearchQuery)
    },
    visibleTreeRoots() {
      if (!this.sopSearchNorm) return this.treeRoots
      return filterHierarchyTreeForSearch(
        this.treeRoots,
        this.visibleSops.map(s => s.uid).filter(Boolean)
      )
    },
    branchSops() {
      const list = this.visibleSops
      if (this.sopSearchNorm) return list
      const sel = String(this.selectedTreeUid || '').trim()
      if (!sel) return list
      return list.filter(sop => {
        if (sop.uid === sel) return true
        const ancestors = sop.ancestorUids || []
        return ancestors.includes(sel)
      })
    },
    branchCards() {
      return groupSopsIntoCards(this.branchSops)
    },
    branchSubtaskCount() {
      return this.branchCards.reduce(
        (sum, card) => sum + ((card.subtasks && card.subtasks.length) || 0),
        0
      )
    },
    branchCardsLabel() {
      const dCount = this.branchCards.length
      const subCount = this.branchSubtaskCount
      if (this.sopSearchNorm) {
        return `匹配 ${dCount} 个 D / ${subCount} 个子任务`
      }
      return `当前分支 ${dCount} 个 D / ${subCount} 个子任务`
    },
    sopActiveJobCount() {
      return (
        (this.sopQueueSnap.runningCount || 0) +
        (this.sopQueueSnap.queuedCount || 0) +
        (this.sopQueueSnap.waitingCount || 0)
      )
    },
    sopTaskJobs() {
      const s = this.sopQueueSnap || {}
      const active = [
        ...(s.running || []),
        ...(s.waiting || []),
        ...(s.pending || [])
      ]
      const activeIds = new Set(active.map(j => j.id))
      const recent = (s.recent || []).filter(j => !activeIds.has(j.id))
      return [...active, ...recent].slice(0, 20)
    },
    detailMode() {
      return !!(this.activeSopUid || (this.$route.query && this.$route.query.sopUid))
    },
    headerBackLabel() {
      if (this.detailMode) return '返回SOP台账'
      return this.roomKey ? '打开导图' : '返回文件'
    },
    detailSopTaskJobs() {
      const uid = String(this.activeSopUid || '').trim()
      if (!uid) return this.sopTaskJobs
      return this.sopTaskJobs.filter(
        j =>
          String(j.sopUid || '') === uid ||
          (this.activeSop &&
            j.sopRowKey &&
            j.sopRowKey === this.activeSop.rowKey)
      )
    },
    detailActiveJobCount() {
      return this.detailSopTaskJobs.filter(j =>
        /^(running|queued|waiting_human|waiting_data)$/.test(j.state)
      ).length
    },
    detailTaskSummary() {
      const list = this.detailSopTaskJobs
      if (!list.length) return ''
      const running = list.filter(j => j.state === 'running').length
      const waiting = list.filter(j =>
        /waiting_/.test(j.state)
      ).length
      return `本 SOP · 执行 ${running} · 等待 ${waiting} · 共 ${list.length}`
    },
    selectedSopJob() {
      const pool = this.detailMode ? this.detailSopTaskJobs : this.sopTaskJobs
      if (!this.selectedSopJobId) return pool[0] || null
      return (
        pool.find(j => j.id === this.selectedSopJobId) ||
        this.sopTaskJobs.find(j => j.id === this.selectedSopJobId) ||
        (this.sopRunQueue && this.sopRunQueue.getJob(this.selectedSopJobId)) ||
        null
      )
    },
    selectedDetailJob() {
      return this.selectedSopJob
    },
    selectedNotifyRows() {
      const job = this.selectedSopJob
      if (!job) return []
      const list =
        (job.notifyResults && job.notifyResults.length
          ? job.notifyResults
          : job.result && job.result.notifyResults) || []
      return list.map(r => {
        const assignee = String((r && r.assignee) || '负责人').trim() || '负责人'
        const text = String(
          (r && (r.displayTitle || r.text)) || ''
        ).trim()
        const parts = []
        if (r.cpdaOk) parts.push(`导图待办 ${r.taskUid || '已写'}`)
        else if (r.cpdaError) parts.push(`导图失败：${r.cpdaError}`)
        else parts.push('导图待办未写入')
        const backendName =
          r.dispatchBackendLabel ||
          (r.dispatchVia === 'xiaoce-wecom'
            ? '小策'
            : r.dispatchVia === 'openclaw-wecom'
              ? '助理'
              : 'WorkBuddy')
        if (r.dispatchOk) parts.push(`${backendName} 企微已派发`)
        else if (r.dispatchError)
          parts.push(`${backendName} 失败：${String(r.dispatchError).slice(0, 48)}`)
        else if (r.dispatchReply)
          parts.push(`${backendName}：${String(r.dispatchReply).slice(0, 48)}`)
        else parts.push(`${backendName} 未确认`)
        return {
          kind: r.block ? '阻塞' : '知会',
          assignee,
          text,
          meta: parts.join(' · '),
          block: !!r.block,
          failed: !r.cpdaOk && !r.dispatchOk
        }
      })
    },
    selectedJobStreamDisplay() {
      const job = this.selectedSopJob
      if (!job) return ''
      const parts = []
      const running = job.state === 'running' || job.state === 'queued'
      const status = String(job.status || '').trim()
      if (running && status) {
        const sec = job.liveElapsedSec
          ? ` · ${job.liveElapsedSec}s`
          : ''
        parts.push(`[进行中${sec}] ${status}`)
      }
      const progress = String(job.progressText || '').trim()
      if (progress) parts.push(progress)
      const modelText = String(job.streamText || '').trim()
      if (modelText) {
        parts.push(parts.length ? `\n—— 模型输出 ——\n${modelText}` : modelText)
      } else if (running && !progress) {
        const backendName =
          (job && job.backendLabel) ||
          (job && job.backend === 'xiaoce'
            ? '小策'
            : job && job.backend === 'openclaw'
              ? '助理'
              : 'WorkBuddy')
        parts.push(`等待 ${backendName} 输出…（状态与工具事件会在此滚动更新）`)
      } else if (!running && job.error) {
        parts.push(job.error)
      }
      return parts.filter(Boolean).join('\n')
    },
    runSubmitZoneHint() {
      if (this.runSubmitSource === 'recruit_fallback') {
        return '招聘类保底模板（大纲未抽出字段）'
      }
      if (this.runSubmitSource === 'outline_zone_empty') {
        return '大纲有「提交资料」区，请按实际要求填写'
      }
      const zones = this.runSubmitZones || []
      if (!zones.length) return ''
      return `来自：${zones.slice(0, 2).join(' / ')}`
    }
  },
  watch: {
    dialogTab(val) {
      if (val !== 'map') return
      this.$nextTick(() => {
        if (
          this.pendingRoot &&
          !this.previewMindMap &&
          !this.subtreeLoading &&
          !this.subtreeError
        ) {
          this.mountPreviewMindMap(this.pendingRoot, this.pendingVersion)
          return
        }
        try {
          const view = this.previewMindMap && this.previewMindMap.view
          if (view && typeof view.fit === 'function') view.fit()
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event('resize'))
          }
        } catch (e) {
          /* ignore */
        }
      })
    },
    spaceDirectoryQuery() {
      this.scheduleSpaceDirectorySearch()
    },
    '$route.query.room'(val) {
      const next = String(val || '').trim()
      if (next !== this.roomKey) {
        this.roomKey = next
        this.refreshRoomList()
      }
    },
    '$route.query.sopUid'(val) {
      const uid = String(val || '').trim()
      if (!uid) {
        if (this.activeSopUid) {
          this.teardownPreview()
          this.activeSop = null
          this.activeSopUid = ''
          this.pendingRoot = null
        }
        return
      }
      this.openDetailFromRoute()
    },
    '$route.query.tab'(val) {
      if (!this.detailMode) return
      const tab = String(val || 'runs')
      if (tab === 'runs' || tab === 'dels' || tab === 'map') {
        this.dialogTab = tab
      }
    }
  },
  async created() {
    this.initLocalConfig()
    this._sopPageAlive = true
    // 台账页固定浅色产品风格，避免跟随编辑器暗色把弹窗/输入框弄成黑底浅字
    this._hadBodyDark = document.body.classList.contains('isDark')
    document.body.classList.remove('isDark')
    this.sopRunQueue = getSharedSopRunQueue({
      getConcurrency: () => resolveSopRunConcurrency()
    })
    this._sopQueueUnsub =
      this.sopRunQueue && this.sopRunQueue.subscribe
        ? this.sopRunQueue.subscribe(snap => {
            if (!this._sopPageAlive) return
            this.sopQueueSnap = snap
            this.syncLedgersFromQueue(snap)
            this.scrollRunStream()
          })
        : null
    // 重新挂载 / 整页刷新后立刻同步已有任务（含 session 恢复的排队/续跑）
    if (this.sopRunQueue && this.sopRunQueue.getSnapshot) {
      this.sopQueueSnap = this.sopRunQueue.getSnapshot()
      const snap = this.sopQueueSnap
      this.syncLedgersFromQueue(snap)
      const prefer =
        (snap.waiting || []).find(j => j.state === 'waiting_human') ||
        (snap.waiting || [])[0] ||
        (snap.running || [])[0] ||
        (snap.pending || []).find(
          j => j && /刷新后自动续跑|刷新后恢复排队/.test(String(j.status || ''))
        ) ||
        (snap.pending || [])[0]
      if (prefer && !this.selectedSopJobId) {
        this.selectedSopJobId = prefer.id
      }
    }
    this.roomKey = roomFromLocation(this.$route) || ''
    await this.loadSpaces()
    if (this.roomKey) {
      await this.refreshRoomList()
      if (this.$route.query && this.$route.query.sopUid) {
        await this.openDetailFromRoute()
      }
    } else this.statusText = '请选择空间'
  },
  beforeDestroy() {
    this._sopPageAlive = false
    this._subtreeLoadToken = (this._subtreeLoadToken || 0) + 1
    this.teardownPreview()
    // 不 cancelAll：任务继续在单例队列里跑；只卸掉本页监听
    if (this._sopQueueUnsub) {
      try {
        this._sopQueueUnsub()
      } catch (e) {
        /* ignore */
      }
      this._sopQueueUnsub = null
    }
    if (this._hadBodyDark) document.body.classList.add('isDark')
    else document.body.classList.remove('isDark')
  },
  methods: {
    ...mapMutations(['setLocalConfig']),
    initLocalConfig() {
      const config = getLocalConfig()
      if (config) {
        this.setLocalConfig({
          ...this.$store.state.localConfig,
          ...config
        })
      }
    },
    goBack() {
      if (this.detailMode) {
        this.leaveDetail()
        return
      }
      if (this.roomKey) {
        this.$router.push({ path: '/', query: { room: this.roomKey } })
        return
      }
      this.$router.push({ path: '/files' })
    },
    leaveDetail() {
      this.teardownPreview()
      this.pendingRoot = null
      this.pendingVersion = 0
      this.subtreeError = ''
      this.activeSop = null
      this.activeSopUid = ''
      this.dialogTab = 'runs'
      this.dialogVisible = false
      const room = String(this.roomKey || '').trim()
      this.$router
        .replace({
          path: '/sop',
          query: room ? { room } : {}
        })
        .catch(() => {})
      if (room) this.refreshRoomList()
    },
    reloadDetail() {
      if (this.activeSop) this.loadSubtreeContent(this.activeSop)
    },
    spaceOptionLabel(item) {
      const key = item.room_key || item.roomKey || ''
      const title = item.title || item.name || ''
      if (title && title !== key) return title
      return key || title || '未命名'
    },
    spaceAccessLabel(item) {
      const role = String((item && item.role) || '').toLowerCase()
      if (role === 'owner') return '所有者'
      if (role === 'viewer' || (item && item.canEdit === false)) return '只读'
      return '可编辑'
    },
    spaceOwnerName(item) {
      const owner = (item && item.owner) || {}
      return String(
        owner.name ||
          (item && (item.ownerName || item.owner_name)) ||
          ''
      ).trim()
    },
    mapSpaceOption(item) {
      const room_key = item.room_key || item.roomKey || ''
      return {
        room_key,
        title: item.title || item.name || '',
        label: this.spaceOptionLabel(item),
        folderId: item.folderId || item.folder_id || null,
        role: item.role || null,
        canEdit: item.canEdit,
        canManage: item.canManage,
        accessLabel: this.spaceAccessLabel(item),
        ownerName: this.spaceOwnerName(item)
      }
    },
    ensureCurrentSpaceOption() {
      const key = String(this.roomKey || '').trim()
      if (!key) return
      if (this.spaceOptions.some(s => s.room_key === key)) return
      this.spaceOptions.unshift({
        room_key: key,
        title: key,
        label: key,
        folderId: null,
        role: null,
        canEdit: false,
        canManage: false,
        accessLabel: '权限校验中',
        ownerName: ''
      })
    },
    mergeSpaceOptions(list, { reset = false } = {}) {
      const mapped = (list || [])
        .map(item => this.mapSpaceOption(item))
        .filter(item => item.room_key)
      if (reset) {
        this.spaceOptions = mapped
      } else {
        const seen = new Set(this.spaceOptions.map(s => s.room_key))
        const extra = mapped.filter(s => !seen.has(s.room_key))
        if (extra.length) this.spaceOptions = this.spaceOptions.concat(extra)
      }
      this.ensureCurrentSpaceOption()
    },
    buildPersonalSpaceDirectoryOptions() {
      const folders = Array.isArray(this.folders) ? this.folders : []
      const folderById = new Map()
      folders.forEach(folder => {
        if (folder && folder.id) folderById.set(String(folder.id), folder)
      })

      const byName = (a, b) =>
        String((a && (a.name || a.title || a.label)) || '').localeCompare(
          String((b && (b.name || b.title || b.label)) || ''),
          'zh-CN'
        )
      const buildFolder = folder => {
        const id = String(folder.id)
        const hasChildFolder = folders.some(
          item => item && String(item.parentId || item.parent_id || '') === id
        )
        return {
          value: `folder:${id}`,
          label: folder.name || '未命名文件夹',
          kind: 'folder',
          folderId: id,
          roomCount: Number(folder.roomCount || 0),
          // Folder nodes are intentionally empty at first. Element UI invokes
          // loadSpaceDirectoryNode only when the user expands one.
          isLeaf: !hasChildFolder && !Number(folder.roomCount || 0)
        }
      }

      const tree = folders
        .filter(folder => {
          const parentId = String((folder && (folder.parentId || folder.parent_id)) || '')
          return !parentId || !folderById.has(parentId)
        })
        .slice()
        .sort(byName)
        .map(buildFolder)
      // The root is a virtual folder. Its rooms are fetched only after it is
      // expanded, rather than during SOP page initialization.
      tree.push({
        value: 'folder:ungrouped',
        label: '未分组',
        kind: 'folder',
        folderId: null,
        roomCount: Number(this.ungroupedRoomCount || 0),
        isLeaf: !Number(this.ungroupedRoomCount || 0),
        children: []
      })
      return tree
    },
    buildSpaceDirectoryOptions() {
      const spaces = [
        {
          value: 'space:personal',
          label: '个人空间',
          kind: 'space',
          spaceType: 'personal',
          roomCount: null,
          isLeaf: false
        }
      ]
      ;(this.teamSpaces || [])
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'))
        .forEach(space => {
          if (!space || !space.id) return
          spaces.push({
            value: `space:team:${space.id}`,
            label: space.name || '未命名团队空间',
            kind: 'space',
            spaceType: 'team',
            teamId: String(space.id),
            roomCount: Number(space.roomCount || 0),
            isLeaf: !Number(space.roomCount || 0)
          })
        })
      return spaces
    },
    async loadSpaces() {
      this.spacesLoading = true
      try {
        const [folders, teamSpaces, ungroupedRooms] = await Promise.all([
          folderService.listFolders().catch(() => []),
          teamService.listSpaces().catch(() => []),
          // 只读取一条记录以获得 total，不预加载未分组脑图列表。
          listFiles({ folderId: null, limit: 1 }).catch(() => ({ total: 0 }))
        ])
        this.folders = Array.isArray(folders) ? folders : []
        this.teamSpaces = Array.isArray(teamSpaces) ? teamSpaces : []
        this.ungroupedRoomCount = Number((ungroupedRooms && ungroupedRooms.total) || 0)
        this.$nextTick(() => {
          const tree = this.$refs.spaceDirectoryTree
          if (tree && tree.store) tree.store.setData(this.spaceDirectoryOptions)
        })
      } catch (err) {
        this.folders = []
        this.ungroupedRoomCount = 0
        this.teamSpaces = []
      } finally {
        this.spacesLoading = false
      }
    },
    async loadSpaceDirectoryNode(node, resolve) {
      // Element UI calls `load` once for its invisible root node as well.
      // Root data is supplied after the folder request has completed.
      if (node && node.level === 0) return resolve(this.spaceDirectoryOptions)
      const data = (node && node.data) || {}
      // 搜索结果同样经过懒加载树：仅在“搜索结果”根节点展开时，才把
      // 已由搜索接口返回的命中项注入树中。
      if (data.kind === 'search') return resolve(data.children || [])
      if (data.kind === 'space') {
        if (data.spaceType === 'personal') return resolve(this.buildPersonalSpaceDirectoryOptions())
        if (data.spaceType === 'team') {
          try {
            const rooms = await teamService.listRooms(data.teamId)
            return resolve((rooms || []).map(room => {
              const option = this.mapSpaceOption(room)
              return { ...option, value: option.room_key, kind: 'room', isLeaf: true, roomKey: option.room_key }
            }))
          } catch (err) {
            this.$message.error('团队空间加载失败，请重试')
            return resolve([])
          }
        }
      }
      if (data.kind !== 'folder') return resolve([])
      try {
        const result = await listFiles({
          folderId: data.folderId,
          limit: 100
        })
        const folderId = String(data.folderId || '')
        const folderChildren = data.folderId == null
          ? []
          : this.folders
              .filter(item => item && String(item.parentId || item.parent_id || '') === folderId)
              .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'))
              .map(folder => ({
                value: `folder:${folder.id}`,
                label: folder.name || '未命名文件夹',
                kind: 'folder',
                folderId: String(folder.id),
                roomCount: Number(folder.roomCount || 0),
                isLeaf: !Number(folder.roomCount || 0) && !this.folders.some(item => item && String(item.parentId || item.parent_id || '') === String(folder.id))
              }))
        const rooms = ((result && result.list) || []).map(this.mapSpaceOption)
        // 同一目录的脑图排在子文件夹之前：展开子文件夹后，它自己的
        // “加载更多”不会插进父目录的脑图列表中。
        const roomNodes = rooms.map(room => ({
          value: room.room_key,
          label: room.title || room.label || room.room_key,
          kind: 'room',
          isLeaf: true,
          roomKey: room.room_key,
          role: room.role,
          canEdit: room.canEdit,
          accessLabel: room.accessLabel,
          ownerName: room.ownerName
        }))
        const moreNode = result && result.nextCursor
          ? [{
              value: `more:${data.value}:${result.nextCursor}`,
              label: '加载更多脑图',
              kind: 'more',
              isLeaf: true,
              folderId: data.folderId,
              cursor: result.nextCursor
            }]
          : []
        // 分页操作紧跟本目录脑图，并在子文件夹之前，避免被误认为
        // 是子层级的分页入口。
        const children = roomNodes.concat(moreNode, folderChildren)
        resolve(children)
      } catch (err) {
        this.$message.error('目录加载失败，请重试')
        resolve([])
      }
    },
    scheduleSpaceDirectorySearch() {
      if (this.spaceDirectorySearchTimer) clearTimeout(this.spaceDirectorySearchTimer)
      const requestId = ++this.spaceDirectorySearchRequestId
      const keyword = String(this.spaceDirectoryQuery || '').trim()
      if (!keyword) {
        this.spaceDirectorySearchResults = []
        this.spaceDirectorySearchLoading = false
        this.refreshSpaceDirectorySearchTree()
        return
      }
      this.spaceDirectorySearchLoading = true
      this.spaceDirectorySearchTimer = setTimeout(async () => {
        try {
          const result = await listFiles({ q: keyword, limit: 100 })
          if (requestId !== this.spaceDirectorySearchRequestId) return
          this.spaceDirectorySearchResults = ((result && result.list) || []).map(room => {
            const option = this.mapSpaceOption(room)
            return { ...option, value: option.room_key, kind: 'room', isLeaf: true, roomKey: option.room_key }
          })
        } catch (err) {
          if (requestId !== this.spaceDirectorySearchRequestId) return
          this.spaceDirectorySearchResults = []
        } finally {
          if (requestId === this.spaceDirectorySearchRequestId) {
            this.spaceDirectorySearchLoading = false
            this.refreshSpaceDirectorySearchTree()
          }
        }
      }, 250)
    },
    refreshSpaceDirectorySearchTree() {
      this.$nextTick(() => {
        const tree = this.$refs.spaceDirectoryTree
        if (!tree || !tree.store) return
        tree.store.setData(this.spaceDirectoryOptions)
        if (!this.spaceDirectoryQuery) return
        const results = tree.getNode('folder:search-results')
        if (results && !results.isLeaf) results.expand()
        tree.filter(this.spaceDirectoryQuery)
      })
    },
    findSpaceDirectoryPath(value, nodes = this.spaceDirectoryOptions, path = []) {
      const target = String(value || '').trim()
      if (!target) return []
      for (const node of nodes || []) {
        const nextPath = path.concat(node)
        if (String(node.value || '') === target) return nextPath
        const found = this.findSpaceDirectoryPath(target, node.children || [], nextPath)
        if (found.length) return found
      }
      return []
    },
    filterSpaceDirectoryNode(query, data) {
      const keyword = String(query || '').trim().toLowerCase()
      if (!keyword) return true
      // 虚拟根节点仅承载命中项，不能因自身文案不匹配而把整组结果过滤掉。
      if (data && data.kind === 'search') return true
      return [data && data.label, data && data.roomKey]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(keyword))
    },
    spaceDirectoryOptionTitle(data) {
      const label = String((data && data.label) || '').trim()
      const roomKey = String((data && data.roomKey) || '').trim()
      if (!roomKey) return label
      return `${label}\n脑图标识：${roomKey}`
    },
    syncSpaceDirectoryTree() {
      this.$nextTick(() => {
        const tree = this.$refs.spaceDirectoryTree
        if (!tree) return
        tree.filter(this.spaceDirectoryQuery)
        const path = this.findSpaceDirectoryPath(this.roomKey)
        path.slice(0, -1).forEach(item => {
          const node = tree.getNode(item.value)
          if (node) node.expand()
        })
        if (this.roomKey) tree.setCurrentKey(this.roomKey)
      })
    },
    onSpaceDirectoryNodeClick(data, node) {
      if (!data) return
      if (data.kind === 'more') {
        this.loadMoreSpaceDirectoryRooms(data, node)
        return
      }
      if (data.kind === 'search') return
      if (data.kind === 'folder' || data.kind === 'space') {
        if (node && node.expanded) node.collapse()
        else if (node) node.expand()
        return
      }
      const room = String(data.roomKey || data.value || '').trim()
      if (!room) return
      this.roomKey = room
      this.spaceDirectoryVisible = false
      this.onSpaceChange(room)
    },
    async loadMoreSpaceDirectoryRooms(data, node) {
      if (!node || node.loading) return
      node.loading = true
      try {
        const result = await listFiles({ folderId: data.folderId, cursor: data.cursor, limit: 100 })
        const parent = node.parent
        let insertAt = parent.childNodes.indexOf(node)
        parent.removeChild(node)
        const rooms = ((result && result.list) || []).map(room => {
          const option = this.mapSpaceOption(room)
          return { ...option, value: option.room_key, kind: 'room', isLeaf: true, roomKey: option.room_key }
        })
        const next = result && result.nextCursor
          ? [{ ...data, value: `more:${parent.data.value}:${result.nextCursor}`, cursor: result.nextCursor }]
          : []
        rooms.concat(next).forEach(item => {
          parent.insertChild({ data: item }, insertAt)
          insertAt += 1
        })
      } catch (err) {
        this.$message.error('继续加载目录失败，请重试')
      } finally {
        node.loading = false
      }
    },
    onSpaceChange(val) {
      const room = String(val || '').trim()
      if (this.activeSopUid) {
        this.teardownPreview()
        this.activeSop = null
        this.activeSopUid = ''
        this.pendingRoot = null
        this.dialogTab = 'runs'
      }
      this.$router.replace({
        path: '/sop',
        query: room ? { room } : {}
      })
      if (room) this.refreshRoomList()
      else {
        this.sops = []
        this.statusText = '请选择空间'
      }
    },
    formatRuns(runs) {
      return (runs || [])
        .slice(0, 3)
        .map(r => [r.at, r.result, r.note].filter(Boolean).join(' '))
        .join('；')
    },
    formatDeliverables(list) {
      return (list || [])
        .slice(0, 4)
        .map(d => d.name || d.uri_or_path)
        .filter(Boolean)
        .join('、')
    },
    sopLedgerRuns(item) {
      return (
        (item && item.sopLedger && item.sopLedger.runs) ||
        (item && item.runs) ||
        []
      )
    },
    sopLedgerDeliverables(item) {
      return (
        (item && item.sopLedger && item.sopLedger.deliverables) ||
        (item && item.deliverables) ||
        []
      )
    },
    sopRunCount(item) {
      return this.sopLedgerRuns(item).length
    },
    sopDeliverableCount(item) {
      return this.sopLedgerDeliverables(item).length
    },
    sopJobsForItem(item) {
      if (!item) return []
      const uid = String(this.resolveSopUid(item) || '').trim()
      const rowKey = String(item.rowKey || '').trim()
      return (this.sopTaskJobs || []).filter(j => {
        if (!j) return false
        if (uid && String(j.sopUid || '') === uid) return true
        if (rowKey && j.sopRowKey && j.sopRowKey === rowKey) return true
        return false
      })
    },
    sopSuccessRateLabel(item) {
      const jobs = this.sopJobsForItem(item)
      const done = jobs.filter(j => j.state === 'done').length
      const failed = jobs.filter(j => j.state === 'error').length
      const denom = done + failed
      if (!denom) return '成功占比 —'
      const pct = Math.round((done / denom) * 100)
      return `成功占比 ${pct}%`
    },
    sopCardMetaChips(item) {
      return [
        `运行 ${this.sopRunCount(item)} 次`,
        `产物 ${this.sopDeliverableCount(item)} 个`,
        this.sopSuccessRateLabel(item)
      ].slice(0, 3)
    },
    latestDelLabel(item) {
      return latestDeliverableText(this.sopLedgerDeliverables(item))
    },
    async refreshScannedArtifacts() {
      const sop = this.activeSop || {}
      const queries = [sop.title, sop.id]
        .map(v => String(v || '').trim())
        .filter(v => v.length >= 2)
      const uniq = Array.from(new Set(queries))
      if (!uniq.length) {
        this.scannedDeliverables = []
        return
      }
      try {
        const batches = await Promise.all(
          uniq.map(q => searchLocalArtifacts(q).catch(() => ({ items: [] })))
        )
        const titleKey = String(sop.title || '').replace(/\s+/g, '')
        const wantId = String(sop.id || '').trim().toUpperCase()
        const seen = new Set()
        const items = []
        batches.forEach(data => {
          ;((data && (data.items || data.list)) || []).forEach(item => {
            const blob = String(item.name || '')
            const fileId = (
              blob.match(/(?:^|[^A-Za-z0-9])(D\d+)(?=[^A-Za-z0-9]|$)/i) || []
            )[1]
            if (wantId && fileId && fileId.toUpperCase() !== wantId) return
            const hitTitle =
              titleKey.length >= 2 && blob.replace(/\s+/g, '').includes(titleKey)
            const hitId = wantId && fileId && fileId.toUpperCase() === wantId
            if (titleKey.length >= 2 && !hitTitle && !hitId) return
            const key = String(item.path || item.name || '').toLowerCase()
            if (!key || seen.has(key)) return
            seen.add(key)
            items.push(item)
          })
        })
        this.scannedDeliverables = items.map(item => ({
          id: `scan_${item.path || item.name}`,
          name: item.name,
          uri_or_path: item.path || item.name,
          kind: 'file',
          mtime: item.mtime || 0
        }))
        this.persistScannedDeliverables(items)
      } catch (e) {
        this.scannedDeliverables = []
      }
    },
    persistScannedDeliverables(items) {
      if (!this.canEditSop || !this.roomKey || !this.activeSopUid) return
      let ledger = normalizeLedger(this.activeLedger)
      const known = new Set(
        (ledger.deliverables || []).map(d =>
          String(d.uri_or_path || '')
            .replace(/\\/g, '/')
            .toLowerCase()
        )
      )
      let added = 0
      ;(items || []).forEach(item => {
        const uri = String(item.path || item.name || '')
        const key = uri.replace(/\\/g, '/').toLowerCase()
        if (!uri || known.has(key)) return
        const n = Number(item.mtime)
        const at =
          n > 1e11
            ? new Date(n).toISOString().slice(0, 16).replace('T', ' ')
            : ''
        ledger = addDeliverableToLedger(ledger, {
          name: item.name,
          uri_or_path: uri,
          kind: 'file',
          sop_id: (this.activeSop && this.activeSop.id) || '',
          sop_uid: this.activeSopUid,
          at
        })
        known.add(key)
        added += 1
      })
      if (!added) return
      this.activeLedger = ledger
      const idx = this.sops.findIndex(
        s => this.resolveSopUid(s) === this.activeSopUid || s === this.activeSop
      )
      if (idx >= 0) {
        const next = {
          ...this.sops[idx],
          deliverables: ledger.deliverables,
          sopLedger: ledger
        }
        this.$set(this.sops, idx, next)
        this.activeSop = next
      }
      persistSopLedger(
        this.roomKey,
        this.activeSopUid,
        {
          id: (this.activeSop && this.activeSop.id) || '',
          title: (this.activeSop && this.activeSop.title) || ''
        },
        ledger
      ).catch(err => {
        console.warn('[sopRegistry] persist scanned deliverables failed', err)
      })
    },
    onSharedRunEnqueued(job) {
      if (job) this.selectedSopJobId = job.id
      if (this.detailMode) {
        this.dialogTab = 'runs'
        this.$router
          .replace({
            path: '/sop',
            query: {
              ...this.$route.query,
              room: this.roomKey,
              sopUid: this.activeSopUid,
              tab: 'runs'
            }
          })
          .catch(() => {})
      } else if (this.runTarget) {
        this.openSubtree(this.runTarget, { tab: 'runs' })
      }
    },
    onSharedRunFinished({ outcome, job }) {
      if (outcome && outcome.ledger) this.applyJobLedgerToList(job, outcome.ledger)
      if (outcome && outcome.ok) {
        this.$message.success(
          `「${job.sopTitle}」完成（约 ${outcome.elapsedSec || 0}s，产物 ${
            (outcome.deliverables && outcome.deliverables.length) || 0
          } 个）`
        )
      }
    },
    onSharedRunWaiting({ outcome, job }) {
      if (outcome && outcome.ledger) this.applyJobLedgerToList(job, outcome.ledger)
      this.selectedSopJobId = job.id
      if (this.detailMode) this.dialogTab = 'runs'
    },
    async openRunDialog(item) {
      if (!this.roomKey) {
        this.$message.warning('请先选择空间')
        return
      }
      if (!this.canEditSop) {
        this.$message.warning('当前为只读权限，无法运行 SOP')
        return
      }
      if (this.sopCardJobState(item)) {
        this.$message.info('该 SOP 已在运行或排队中')
        const job = this.sopRunQueue.findActiveBySop(
          this.roomKey,
          this.resolveSopUid(item)
        )
        if (job) this.selectSopJob(job.id)
        return
      }

      const sopUid = this.resolveSopUid(item)
      const sopForCheck = { ...item, uid: sopUid }
      const assessment = assessNoHyperlinkContinuity(
        sopForCheck,
        this.flatNodes || []
      )
      this.runContinuityNote = ''
      if (assessment.needsCheck) {
        const title =
          assessment.level === 'block'
            ? '无超链接：结构风险较大'
            : '无超链接：请确认流畅与同 P 衔接'
        try {
          await this.$confirm(assessment.summary || '本 SOP 无超链接，是否继续运行？', title, {
            confirmButtonText: '仍要运行',
            cancelButtonText: '取消',
            type: assessment.level === 'block' ? 'error' : 'warning',
            distinguishCancelAndClose: true,
            customClass: 'sopContinuityConfirm'
          })
          this.runContinuityNote = formatContinuityExtraNote(assessment)
        } catch (e) {
          return
        }
      }

      this.runTarget = item
      this.runOutputIds = []
      this.runExtraNote = ''
      this.runAttachments = []
      this.runSubmitFields = []
      this.runSubmitZones = []
      this.runSubmitSource = ''
      const localConfig = getLocalConfig() || {}
      this.runBackend = normalizeAiBackend(
        localConfig.aiBackend || AI_BACKEND_OPENCLAW
      )
      this.runOrganizationId = String(localConfig.xiaoceOrganizationId || '')
      this.runAgentId = String(localConfig.xiaoceAgentId || '')
      if (this.runBackend === AI_BACKEND_OPENCLAW) {
        this.runModel =
          getOpenclawConfig().model || 'openclaw/default'
      } else {
        this.runModel = getWorkbuddyConfig().model || 'deepseek-v4-flash'
      }
      this.runDialogVisible = true
      if (this.runBackend === AI_BACKEND_XIAOCE) this.loadRunXiaoceScope()
      else this.loadRunModels()
      this.loadRunSubmitTemplate(item)
    },
    onRunFilesPicked(event) {
      const files = Array.from(event.target.files || [])
      event.target.value = ''
      this.addRunAttachments(files)
    },
    onRunPaste(event) {
      const clipboard = event.clipboardData
      if (!clipboard) return
      const files = Array.from(clipboard.files || [])
      if (!files.length) {
        Array.from(clipboard.items || []).forEach(item => {
          if (item.kind === 'file') {
            const file = item.getAsFile()
            if (file) files.push(file)
          }
        })
      }
      if (!files.length) return // Keep native text paste, including the caret/selection.
      // Mixed text + files keeps native text insertion as well.
      if (!clipboard.getData('text/plain')) event.preventDefault()
      this.addRunAttachments(files)
    },
    addRunAttachments(files) {
      const roomKey = this.roomKey
      if (!roomKey) return this.$message.warning('请先选择空间')
      for (const file of files) {
        if (this.runAttachments.length >= SOP_ATTACHMENT_LIMIT) {
          this.$message.warning('最多添加 5 个附件，请先删除不需要的文件')
          break
        }
        const error = validateSopAttachment(file)
        if (error) {
          this.$message.warning(`${file.name}：${error}`)
          continue
        }
        const ext = file.name.split('.').pop().toLowerCase()
        const kind = ext === 'pdf' ? 'pdf' : /^(xlsx|csv)$/.test(ext) ? 'sheet' : /^(png|jpe?g|webp|gif)$/.test(ext) ? 'image' : 'document'
        const item = {
          key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name, kind,
          badge: { pdf: 'PDF', sheet: 'X', image: '图', document: '文' }[kind],
          status: 'uploading', error: '', attachmentId: '', extractedText: ''
        }
        this.runAttachments.push(item)
        uploadSopAttachment(roomKey, file).then(attachment => {
          if (!this.runAttachments.includes(item)) return
          Object.assign(item, { status: 'ready', attachmentId: attachment.id, extractedText: attachment.extractedText })
        }).catch(err => {
          if (!this.runAttachments.includes(item)) return
          item.status = 'failed'
          item.error = (err && err.message) || '附件上传失败'
          this.$message.error(`${item.name}：${item.error}`)
        })
      }
    },
    removeRunAttachment(file) {
      this.runAttachments = this.runAttachments.filter(item => item !== file)
    },
    onRunBackendChange(value) {
      this.setLocalConfig({ aiBackend: value })
      if (value === AI_BACKEND_XIAOCE) {
        this.loadRunXiaoceScope(true)
      } else if (value === AI_BACKEND_OPENCLAW) {
        this.runModel =
          getOpenclawConfig().model || 'openclaw/default'
        this.loadRunModels(true)
      } else {
        this.runModel = getWorkbuddyConfig().model || 'deepseek-v4-flash'
        this.loadRunModels()
      }
    },
    async onRunOrganizationChange(value) {
      this.runOrganizationId = String(value || '')
      this.runAgentId = ''
      await this.loadRunXiaoceAgents(true)
    },
    async loadRunXiaoceAgents(selectFallback = false) {
      this.runAgents = this.runOrganizationId
        ? await fetchXiaoceAgents(this.runOrganizationId)
        : []
      if (!this.runAgents.some(item => String(item.id) === this.runAgentId)) {
        this.runAgentId = selectFallback && this.runAgents[0]
          ? String(this.runAgents[0].id)
          : ''
      }
    },
    async loadRunXiaoceScope(showError = false) {
      if (this.runScopeLoading) return
      this.runScopeLoading = true
      try {
        this.runOrganizations = await fetchXiaoceOrganizations()
        if (!this.runOrganizations.some(item => String(item.id) === this.runOrganizationId)) {
          const preferred = this.runOrganizations.find(item => item.isCurrent) || this.runOrganizations[0]
          this.runOrganizationId = preferred ? String(preferred.id) : ''
        }
        await this.loadRunXiaoceAgents(true)
      } catch (err) {
        if (showError) this.$message.error(`小策配置加载失败：${err.message || '未知错误'}`)
      } finally {
        this.runScopeLoading = false
      }
    },
    async loadRunSubmitTemplate(item) {
      if (!item || !this.roomKey) return
      this.runSubmitLoading = true
      try {
        const sop = {
          ...item,
          uid: this.resolveSopUid(item)
        }
        const ctx = await loadSopRunContext(this.roomKey, sop)
        const parsed = extractSubmitMaterialFields(ctx.outline || '', {
          sopTitle: item.title || item.id || ''
        })
        this.runSubmitFields = (parsed.fields || []).map(f => ({
          key: f.key,
          label: f.label,
          hint: f.hint || `请填写${f.label}`,
          value: f.value || ''
        }))
        this.runSubmitZones = parsed.zones || []
        this.runSubmitSource = parsed.source || ''
      } catch (err) {
        console.warn('[sopRegistry] load submit template failed', err)
        this.runSubmitFields = []
        this.runSubmitZones = []
        this.runSubmitSource = ''
      } finally {
        this.runSubmitLoading = false
      }
    },
    onRunModelDropdown(visible) {
      if (visible && !this.runPlatformModels.length) {
        this.loadRunModels()
      }
    },
    async loadRunModels(force = false) {
      if (this.runModelsLoading) return
      this.runModelsLoading = true
      try {
        if (this.runBackend === AI_BACKEND_OPENCLAW) {
          const models = await fetchAiModels(AI_BACKEND_OPENCLAW)
          this.runOpenclawModels =
            models && models.length
              ? models
              : [{ id: 'openclaw/default', name: 'openclaw/default' }]
          const ids = new Set(this.runOpenclawModels.map(m => m.id))
          if (!ids.has(this.runModel)) {
            this.runModel =
              (this.runOpenclawModels[0] && this.runOpenclawModels[0].id) ||
              'openclaw/default'
          }
          return
        }
        const models = await fetchWorkbuddyModels()
        this.runCustomModels = models.filter(m => m.custom)
        this.runPlatformModels = models.filter(m => !m.custom)
        if (!this.runCustomModels.length) {
          this.runCustomModels = WORKBUDDY_CUSTOM_MODEL_HINTS.slice()
        }
        const ids = new Set(
          [...this.runCustomModels, ...this.runPlatformModels].map(m => m.id)
        )
        if (!ids.has(this.runModel)) {
          this.runModel =
            (this.runCustomModels[0] && this.runCustomModels[0].id) ||
            'deepseek-v4-flash'
        }
      } catch (err) {
        if (force && this.$message) {
          this.$message.warning(
            '模型列表加载失败：' + ((err && err.message) || '未知错误')
          )
        }
        if (this.runBackend === AI_BACKEND_OPENCLAW) {
          this.runOpenclawModels = [
            { id: 'openclaw/default', name: 'openclaw/default' }
          ]
        }
      } finally {
        this.runModelsLoading = false
      }
    },
    sopCardJobState(item) {
      if (!this.sopRunQueue || !item) return ''
      const job = this.sopRunQueue.findActiveBySop(
        this.roomKey,
        this.resolveSopUid(item)
      )
      const state = (job && job.state) || ''
      // 补数已关闭：不展示、不阻塞运行
      if (state === 'waiting_data') return ''
      return state
    },
    sopCardJobLabel(item) {
      const state = this.sopCardJobState(item)
      if (state === 'running') return '运行中'
      if (state === 'queued') return '排队中'
      if (state === 'waiting_human') return '等待人工'
      return ''
    },
    sopJobStateLabel(job) {
      const map = {
        running: '运行中',
        queued: '排队',
        waiting_human: '等待人工',
        done: '完成',
        error: '失败',
        cancelled: '已取消'
      }
      return map[job && job.state] || (job && job.state) || ''
    },
    shortJobStatus(job) {
      if (!job) return ''
      if (job.state === 'waiting_human') {
        const n =
          (job.waitingWecomTodos && job.waitingWecomTodos.length) ||
          (job.waitingTaskUids && job.waitingTaskUids.length) ||
          0
        return n ? `等待企微待办 ${n} 条` : '等待企微待办确认'
      }
      const s = String(job.status || '').replace(/\s+/g, ' ').trim()
      if (s.length > 48) return s.slice(0, 48) + '…'
      return s
    },
    selectSopJob(jobId) {
      this.selectedSopJobId = jobId
      this.scrollRunStream()
    },
    cancelSopJob(jobId) {
      if (!this.sopRunQueue) return
      this.sopRunQueue.cancel(jobId)
    },
    async resumeSopJob(jobId) {
      if (!this.sopRunQueue) return
      const job = this.sopRunQueue.getJob(jobId)
      if (!job || job.state !== 'waiting_human') {
        this.$message.warning('该任务不在等待人工状态')
        return
      }
      try {
        const todos =
          (job.waitingWecomTodos && job.waitingWecomTodos.length
            ? job.waitingWecomTodos
            : null) ||
          (job.notifyResults || [])
            .filter(r => r && r.block && r.dispatchOk && !r.skipped)
            .map(r => ({
              todoId: r.todoId || '',
              title: r.wxTitle || r.text || r.title || '',
              assignee: r.assignee || '',
              via: r.dispatchVia || ''
            }))
        if (!todos.length) {
          try {
            await this.$confirm(
              '未记录企微待办信息。若你已在企业微信里完成，可继续执行 SOP。',
              '确认继续',
              { type: 'warning' }
            )
          } catch (e) {
            return
          }
        } else {
          const check = await areWaitingWecomTodosDone(todos, {
            backend: (job && job.backend) || undefined
          })
          if (!check.done) {
            const left = (check.pending || []).length
            const unk = (check.unknown || []).length
            if (left) {
              this.$message.warning(
                `还有 ${left} 条企微待办未完成，请先在企业微信点「已完成」`
              )
              return
            }
            if (unk) {
              try {
                await this.$confirm(
                  '暂时查不到企微待办状态。若你已在企业微信完成，可强制继续。',
                  '确认继续',
                  { type: 'warning' }
                )
              } catch (e) {
                return
              }
            }
          }
        }
        const res = this.sopRunQueue.resumeWaiting(jobId)
        if (!res.ok) {
          this.$message.warning(res.message || '无法继续')
          return
        }
        this.$message.success('已继续执行 SOP')
      } catch (err) {
        this.$message.error((err && err.message) || '检查企微待办失败')
      }
    },
    async continuePartialSopJob(jobId) {
      if (!this.sopRunQueue || !this.roomKey) return
      if (!this.canEditSop) {
        this.$message.warning('当前为只读权限，无法续跑')
        return
      }
      const job = this.sopRunQueue.getJob(jobId)
      const rr = (job && job.result && job.result.runResult) || ''
      if (
        !job ||
        (job.state !== 'partial' && rr !== '部分完成')
      ) {
        this.$message.warning('只能对「部分完成」的任务续跑')
        return
      }
      const sop =
        this.activeSop ||
        this.sops.find(
          s =>
            this.resolveSopUid(s) === job.sopUid ||
            (s.uids && s.uids.includes(job.sopUid))
        )
      if (!sop || !sop.title) {
        this.$message.warning('找不到该 SOP，请从台账详情里续跑')
        return
      }
      const steps = Array.isArray(job.nodeProgress) ? job.nodeProgress : []
      const unfinished = steps.filter(s =>
        ['pending', 'active', 'failed'].includes(String(s.status || ''))
      )
      const dels =
        (job.result && job.result.deliverables) || job.deliverables || []
      const delLines = dels
        .map(d => `- ${(d && d.name) || ''}：${(d && d.uri_or_path) || ''}`)
        .filter(line => !/：\s*$/.test(line))
        .join('\n')
      const note = [
        '## 断点续跑',
        '上一轮结果是部分完成。已标 done 的步骤不要重做；只推进未完成步骤，并覆盖更新同一份 HTML。',
        unfinished.length
          ? `未完成步骤：\n${unfinished
              .map(
                s =>
                  `- ${s.title}${s.detail ? `（${s.detail}）` : ''}`
              )
              .join('\n')}`
          : '请从节点流第一个未完成步骤继续。',
        delLines ? `上一轮产物：\n${delLines}` : '',
        '若「跟踪渠道GMV目标完成进度」缺 GMV 实际/完成率：先把分配与下发做完；缺数项标待接入并写清缺哪两列，不要整单假完成。'
      ]
        .filter(Boolean)
        .join('\n\n')
      try {
        await this.$confirm(
          unfinished.length
            ? `将从未完成的 ${unfinished.length} 个步骤续跑。跟踪步若仍缺实际 GMV，可能仍会部分完成。`
            : '将按上一轮进度续跑本 SOP。',
          '断点续跑',
          { type: 'info', confirmButtonText: '开始续跑' }
        )
      } catch (e) {
        return
      }
      const enqueued = await this.sopRunQueue.enqueue({
        roomKey: this.roomKey,
        sop: {
          ...sop,
          uid: this.resolveSopUid(sop) || job.sopUid
        },
        outputIds: (job.outputIds && job.outputIds.length
          ? job.outputIds
          : ['html']
        ).slice(),
        extraNote: note,
        model: job.model || this.runModel,
        backend: job.backend || this.runBackend,
        actor: this.userInfo.name || '台账',
        priorNodeProgress: steps,
        completedNotifyKeys: job.completedNotifyKeys || [],
        onSuccess: (result, j) => {
          if (!this._sopPageAlive) return
          if (result && result.ledger) {
            this.applyJobLedgerToList(j, result.ledger)
          }
          const partial = result && result.runResult === '部分完成'
          if (result && result.ok && !partial) {
            this.$message.success(
              `「${j.sopTitle}」续跑完成（约 ${result.elapsedSec}s）`
            )
          } else if (partial) {
            this.$message.warning(
              `「${j.sopTitle}」仍部分完成：${
                (result.assessment && result.assessment.reason) ||
                '还有步骤缺数据'
              }`
            )
          } else {
            this.$message.warning(
              `「${j.sopTitle}」：${
                (result && result.assessment && result.assessment.reason) ||
                (result && result.runResult) ||
                '未确认真执行'
              }`
            )
          }
        },
        onError: (err, msg) => {
          if (!this._sopPageAlive) return
          this.$message.error(msg || (err && err.message) || '续跑失败')
        }
      })
      if (!enqueued.ok) {
        this.$message.warning(enqueued.message || '入队失败')
        return
      }
      if (enqueued.job && enqueued.job.id) {
        this.selectedSopJobId = enqueued.job.id
      }
      this.$message.success('已入队续跑')
    },
    cancelAllSopJobs() {
      if (!this.sopRunQueue) return
      this.sopRunQueue.cancelAll()
      this.$message.info('已取消全部 SOP 任务')
    },
    async onArtifactOptimized(payload) {
      const { jobId, source, deliverable, instruction, resolve, reject } =
        payload || {}
      try {
        const job =
          this.sopTaskJobs.find(item => item && item.id === jobId) ||
          (this.sopRunQueue && this.sopRunQueue.getJob(jobId))
        if (!job || !deliverable) throw new Error('找不到对应的 SOP 任务')

        let ledger = normalizeLedger(
          (job.result && job.result.ledger) || this.activeLedger
        )
        ledger = addDeliverableToLedger(ledger, {
          ...deliverable,
          sop_id: job.sopId || '',
          sop_uid: job.sopUid || '',
          derived_from:
            (source && (source.id || source.uri_or_path || source.name)) || '',
          optimization_instruction: instruction || ''
        })

        const runDeliverables = Array.isArray(
          job.result && job.result.deliverables
        )
          ? job.result.deliverables.slice()
          : []
        const newPath = String(deliverable.uri_or_path || '').toLowerCase()
        if (
          !runDeliverables.some(
            item =>
              String((item && item.uri_or_path) || '').toLowerCase() === newPath
          )
        ) {
          runDeliverables.push({
            ...deliverable,
            derived_from:
              (source && (source.id || source.uri_or_path || source.name)) || '',
            optimization_instruction: instruction || ''
          })
        }
        if (!job.result) this.$set(job, 'result', {})
        this.$set(job.result, 'deliverables', runDeliverables)
        this.$set(job.result, 'ledger', ledger)
        this.activeLedger = ledger
        this.applyJobLedgerToList(job, ledger)
        await persistSopLedger(
          job.roomKey || this.roomKey,
          job.sopUid || this.activeSopUid,
          { id: job.sopId || '', title: job.sopTitle || '' },
          ledger
        )
        if (this.sopRunQueue && this.sopRunQueue.updateJobLedger) {
          this.sopRunQueue.updateJobLedger(jobId, ledger, runDeliverables)
        }
        if (resolve) resolve(deliverable)
      } catch (error) {
        if (reject) reject(error)
        else throw error
      }
    },
    applyJobLedgerToList(job, ledger) {
      if (!job || !ledger) return
      // 严格按节点 uid 归属，避免多任务回写串到别的 SOP 卡片
      const idx = this.sops.findIndex(s => {
        if (job.sopUid) {
          if (this.resolveSopUid(s) === job.sopUid) return true
          if (s.uids && s.uids.includes(job.sopUid)) return true
          return false
        }
        return !!(job.sopRowKey && s.rowKey === job.sopRowKey)
      })
      if (idx < 0) return
      const scoped = this.scopeLedgerToSop(ledger, {
        id: job.sopId,
        uid: job.sopUid,
        title: job.sopTitle
      })
      const next = {
        ...this.sops[idx],
        runs: scoped.runs,
        deliverables: scoped.deliverables,
        frequency: scoped.frequency,
        sopLedger: scoped
      }
      this.$set(this.sops, idx, next)
    },
    scopeLedgerToSop(ledger, sopMeta) {
      const L = normalizeLedger(ledger)
      const wantId = String((sopMeta && sopMeta.id) || '')
        .trim()
        .toUpperCase()
      if (!wantId) return L
      const titleKey = String((sopMeta && sopMeta.title) || '')
        .replace(/\s+/g, '')
        .slice(0, 12)
      const keep = d => {
        const blob = `${d.name || ''}\n${d.uri_or_path || ''}`
        const fileId = (blob.match(/(?:^|[^A-Za-z0-9])(D\d+)(?=[^A-Za-z0-9]|$)/i) ||
          [])[1]
        if (fileId && fileId.toUpperCase() !== wantId) return false
        if (d.sop_id && String(d.sop_id).toUpperCase() !== wantId) return false
        if (d.sop_uid && sopMeta.uid && d.sop_uid !== sopMeta.uid) return false
        // 有其它 D 编号痕迹且标题也对不上时丢掉
        if (
          fileId &&
          titleKey &&
          titleKey.length >= 2 &&
          !blob.includes(titleKey) &&
          fileId.toUpperCase() !== wantId
        ) {
          return false
        }
        return true
      }
      return normalizeLedger({
        ...L,
        deliverables: (L.deliverables || []).filter(keep)
      })
    },
    syncLedgersFromQueue(snap) {
      const jobs = [
        ...((snap && snap.running) || []),
        ...((snap && snap.waiting) || []),
        ...((snap && snap.recent) || [])
      ]
      // 只回写已结束/等待且带 ledger 的任务；按 uid 精确落到对应卡片
      jobs.forEach(job => {
        if (
          job &&
          job.result &&
          job.result.ledger &&
          (job.state === 'done' ||
            job.state === 'error' ||
            job.state === 'cancelled' ||
            job.state === 'waiting_human' ||
            job.state === 'waiting_data')
        ) {
          this.applyJobLedgerToList(job, job.result.ledger)
        }
      })
      this.backfillDeliverablesFromJobs(jobs)
    },
    backfillDeliverablesFromJobs(jobs) {
      ;(jobs || []).forEach(job => {
        if (!job || !job.roomKey || !job.sopUid || job._deliverableBackfill) return
        const text = [
          job.result && job.result.reply,
          job.streamText,
          job.progressText
        ]
          .filter(Boolean)
          .join('\n')
        if (
          !/(产物清单|drive\.weixin\.qq\.com|[A-Za-z]:[\\/][^\n]+\.(html?|xlsx?))/i.test(
            text
          )
        ) {
          return
        }
        const extracted = extractDeliverablesFromReply(text, [], [], {
          id: job.sopId,
          title: job.sopTitle,
          uid: job.sopUid,
          sopId: job.sopId,
          sopTitle: job.sopTitle,
          sopUid: job.sopUid
        })
        if (!extracted.length) return
        let ledger = normalizeLedger((job.result && job.result.ledger) || {})
        const known = new Set(
          (ledger.deliverables || []).map(d => String(d.uri_or_path || ''))
        )
        let added = 0
        extracted.forEach(d => {
          const uri = String(d.uri_or_path || '')
          if (!uri || known.has(uri)) return
          ledger = addDeliverableToLedger(ledger, {
            ...d,
            sop_id: job.sopId,
            sop_uid: job.sopUid
          })
          known.add(uri)
          added += 1
        })
        if (!added) {
          job._deliverableBackfill = true
          return
        }
        job._deliverableBackfill = true
        if (job.result) job.result.ledger = ledger
        this.applyJobLedgerToList(job, ledger)
        persistSopLedger(
          job.roomKey,
          job.sopUid,
          { id: job.sopId || '', title: job.sopTitle || '' },
          ledger
        ).catch(err => {
          job._deliverableBackfill = false
          console.warn('[sopRegistry] backfill deliverables failed', err)
        })
      })
    },
    /** 刷新列表时保留内存台账 + 队列已回写结果，避免「最近运行/产物」被刷空 */
    mergeSopsPreservingRuns(fetched) {
      const prevByUid = new Map()
      const prevByRow = new Map()
      ;(this.sops || []).forEach(s => {
        const uid = this.resolveSopUid(s)
        if (uid) prevByUid.set(uid, s)
        if (s.rowKey) prevByRow.set(s.rowKey, s)
        ;(s.uids || []).forEach(u => {
          if (u && !prevByUid.has(u)) prevByUid.set(u, s)
        })
      })
      const queueLedgers =
        (this.sopRunQueue &&
          this.sopRunQueue.collectLedgers &&
          this.sopRunQueue.collectLedgers(this.roomKey)) ||
        new Map()

      return (fetched || []).map(item => {
        const uid = this.resolveSopUid(item)
        const prev =
          (uid && prevByUid.get(uid)) ||
          (item.rowKey && prevByRow.get(item.rowKey)) ||
          null
        let ledger = mergeLedgerSources(
          item.sopLedger || item,
          prev ? prev.sopLedger || prev : null
        )
        if (uid && queueLedgers.has(uid)) {
          ledger = mergeLedgerSources(ledger, queueLedgers.get(uid))
        }
        if (item.uids) {
          item.uids.forEach(u => {
            if (queueLedgers.has(u)) {
              ledger = mergeLedgerSources(ledger, queueLedgers.get(u))
            }
          })
        }
        return {
          ...item,
          runs: ledger.runs,
          deliverables: ledger.deliverables,
          frequency: ledger.frequency || item.frequency,
          sopLedger: ledger
        }
      })
    },
    openJobDeliverables(job) {
      const item = this.sops.find(
        s =>
          s.rowKey === job.sopRowKey ||
          this.resolveSopUid(s) === job.sopUid
      )
      if (!item) {
        this.$message.warning('列表中找不到该 SOP')
        return
      }
      this.openSubtree(item, { tab: 'dels' })
    },
    async cloneOutputRulesMap() {
      if (this.cloningOutputRules) return
      this.cloningOutputRules = true
      try {
        const created = await cloneSopOutputRulesTemplate()
        this.$message.success(`已复制「${created.title}」到我的空间`)
        if (created.roomKey && this.$router) {
          this.$router
            .push({ path: '/', query: { room: created.roomKey } })
            .catch(() => {})
        }
      } catch (err) {
        this.$message.error((err && err.message) || '复制输出规则脑图失败')
      } finally {
        this.cloningOutputRules = false
      }
    },
    scrollRunStream() {
      this.$nextTick(() => {
        const el = this.$refs.runStreamPre
        if (el) el.scrollTop = el.scrollHeight
      })
    },
    async confirmRunSop() {
      if (!this.runTarget || !this.roomKey || !this.sopRunQueue) return
      if (!this.canEditSop) {
        this.$message.warning('当前为只读权限，无法运行 SOP')
        return
      }
      if (this.runSubmitLoading) {
        this.$message.info('资料模板加载中，请稍候')
        return
      }
      if (this.runBackend === AI_BACKEND_XIAOCE && (!this.runOrganizationId || !this.runAgentId)) {
        this.$message.warning('请先选择企业和智能体')
        return
      }
      this.setLocalConfig({
        aiBackend: this.runBackend,
        xiaoceOrganizationId: this.runOrganizationId,
        xiaoceAgentId: this.runAgentId
      })
      if (this.runSubmitFields.length) {
        const missing = missingSubmitMaterialLabels(this.runSubmitFields)
        if (missing.length) {
          this.$message.warning(`请先填写：${missing.slice(0, 5).join('、')}`)
          return
        }
      }
      if (this.runModel) {
        if (this.runBackend === AI_BACKEND_OPENCLAW) {
          this.setLocalConfig({ openclawModel: this.runModel })
          saveOpenclawConfig({ model: this.runModel })
        } else {
          this.setLocalConfig({ workbuddyModel: this.runModel })
        }
      }
      const sop = {
        ...this.runTarget,
        uid: this.resolveSopUid(this.runTarget)
      }
      if (this.runAttachments.some(file => file.status !== 'ready')) {
        this.$message.warning('请等待附件解析完成，或删除失败的附件后重试')
        return
      }
      const materialNote = formatSubmitMaterialNote(
        this.runSubmitFields,
        formatSopAttachmentNote(this.runExtraNote, this.runAttachments)
      )
      const continuityNote = String(this.runContinuityNote || '').trim()
      const mergedExtra = [materialNote || this.runExtraNote, continuityNote]
        .filter(Boolean)
        .join('\n\n')
      const enqueued = await this.sopRunQueue.enqueue({
        roomKey: this.roomKey,
        sop,
        outputIds: this.runOutputIds.slice(),
        extraNote: mergedExtra,
        model: this.runModel,
        backend: this.runBackend,
        actor: this.userInfo.name || '台账',
        onSuccess: (result, job) => {
          if (!this._sopPageAlive) return
          if (result && result.ledger) {
            this.applyJobLedgerToList(job, result.ledger)
          }
          if (result && result.ok) {
            const partial = result.runResult === '部分完成'
            if (partial) {
              this.$message.warning(
                `「${job.sopTitle}」部分完成（约 ${result.elapsedSec}s）：${
                  (result.assessment && result.assessment.reason) ||
                  '后半步骤未跑完或产物空壳'
                }`
              )
            } else {
              this.$message.success(
                `「${job.sopTitle}」完成（约 ${result.elapsedSec}s，产物 ${
                  (result.deliverables && result.deliverables.length) || 0
                } 个）`
              )
            }
          } else {
            const reason =
              (result &&
                result.assessment &&
                result.assessment.reason) ||
              (result && result.runResult) ||
              '未确认真执行'
            this.$message.warning(`「${job.sopTitle}」：${reason}`)
          }
        },
        onError: (err, msg) => {
          if (!this._sopPageAlive) return
          if (err && err.ledger) {
            this.applyJobLedgerToList(
              {
                sopRowKey: sop.rowKey,
                sopUid: sop.uid
              },
              err.ledger
            )
          }
          if (!(err && err.name === 'AbortError')) {
            this.$message.error(`「${sop.title}」：${msg}`)
          }
        },
        onWaiting: (result, job) => {
          if (!this._sopPageAlive) return
          if (result && result.ledger) {
            this.applyJobLedgerToList(job, result.ledger)
          }
          this.selectedSopJobId = job.id
          if (this.detailMode) this.dialogTab = 'runs'
          const assignees = ((result && result.notifyResults) || [])
            .map(r => String((r && r.assignee) || '').trim())
            .filter(Boolean)
          const uniq = [...new Set(assignees)]
          const who = uniq.length ? `代办发给：${uniq.join('、')}` : ''
          if (result && result.waitingData) {
            // 补数已关闭：不弹补数窗、不提示「去补数」
            return
          }
          const n =
            (job.waitingWecomTodos && job.waitingWecomTodos.length) ||
            (job.waitingTaskUids && job.waitingTaskUids.length) ||
            0
          this.$message.warning(
            `「${job.sopTitle}」已派发阻塞通知${
              who ? `，${who}` : ''
            }，请在企业微信完成待办后点「检查并继续」${n ? `（${n} 条）` : ''}`
          )
        }
      })
      if (!enqueued.ok) {
        this.$message.warning(enqueued.message || '入队失败')
        return
      }
      this.selectedSopJobId = enqueued.job.id
      this.runDialogVisible = false
      this.runContinuityNote = ''
      if (this.detailMode) {
        this.dialogTab = 'runs'
        this.$router
          .replace({
            path: '/sop',
            query: {
              ...this.$route.query,
              room: this.roomKey,
              sopUid: this.activeSopUid,
              tab: 'runs'
            }
          })
          .catch(() => {})
      } else if (this.runTarget) {
        // 从台账列表运行：直接进入该 SOP 详情的「记录」
        this.openSubtree(this.runTarget, { tab: 'runs' })
      }
      this.$message.success(
        `已加入队列：${sop.title}（并发上限 ${
          this.sopQueueSnap.concurrency || 2
        }）`
      )
    },
    resolveSopUid(item) {
      if (!item) return ''
      return String(item.uid || '').trim()
    },
    escapeHtml(text) {
      return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    },
    highlightText(text, query) {
      const raw = String(text || '')
      const q = String(query || '').trim()
      if (!q) return this.escapeHtml(raw)
      const lower = raw.toLowerCase()
      const needle = q.toLowerCase()
      let out = ''
      let i = 0
      while (i < raw.length) {
        const hit = lower.indexOf(needle, i)
        if (hit < 0) {
          out += this.escapeHtml(raw.slice(i))
          break
        }
        out += this.escapeHtml(raw.slice(i, hit))
        out += `<mark>${this.escapeHtml(raw.slice(hit, hit + needle.length))}</mark>`
        i = hit + needle.length
      }
      return out
    },
    sopBreadcrumb(item) {
      const segs = (item && item.pathSegments) || []
      if (segs.length) return segs.join(' / ')
      return (item && item.source && item.source.path) || ''
    },
    sopFullPath(item) {
      const path = this.sopBreadcrumb(item)
      if (path) return path
      return formatSopDisplayTitle(item, 'D')
    },
    formatSubtaskTitle(sub) {
      return formatSubtaskDisplayTitle(sub)
    },
    subtaskGlyphKind(sub) {
      if (sub && sub.isFallbackSubtask) return 'node'
      const title = String((sub && sub.title) || '')
      if (/^[Dd](?!\d)\s*[：:]/.test(title.trim())) return 'D'
      if (String((sub && sub.id) || '').toUpperCase() === 'D') return 'D'
      return 'node'
    },
    subtaskDesc(sub) {
      const path = this.sopBreadcrumb(sub)
      if (!path) return '子任务'
      const parts = path.split(' / ')
      return parts.length > 1 ? parts.slice(0, -1).join(' / ') : path
    },
    subtaskStateLabel(sub) {
      const job = this.sopCardJobState(sub)
      if (job === 'running') return '运行中'
      if (job === 'queued') return '排队中'
      if (job === 'waiting_human') return '等待中'
      const runs = this.sopLedgerRuns(sub)
      if (!runs.length) return '未运行'
      const latest = runs[0]
      const result = String((latest && latest.result) || '')
      if (/失败|错误|error|疑似空跑|未拿到|未真正/i.test(result)) return '失败'
      if (/部分完成/.test(result)) return '部分完成'
      if (/完成|成功|ok/i.test(result)) return '已完成'
      return result || '已运行'
    },
    subtaskStateClass(sub) {
      const label = this.subtaskStateLabel(sub)
      if (label === '未运行') return 'idle'
      if (label === '运行中' || label === '排队中' || label === '等待中') {
        return 'active'
      }
      if (label === '失败') return 'fail'
      if (label === '部分完成') return 'partial'
      return 'done'
    },
    subtaskUpdatedAt(sub) {
      const runs = this.sopLedgerRuns(sub)
      const at = runs[0] && (runs[0].at || runs[0].createdAt)
      if (at) return String(at).replace('T', ' ').slice(0, 16)
      return '—'
    },
    toggleCardCollapse(uid) {
      this.$set(this.cardCollapsed, uid, !this.cardCollapsed[uid])
    },
    onSubtaskMenu(cmd, sub) {
      if (cmd === 'detail') this.openSubtree(sub)
      else if (cmd === 'locate') this.locateSopInMap(sub)
    },
    rebuildHierarchyTree() {
      const withSubs = attachFallbackSubtasks(this.sops, this.flatNodes)
      const byUid = new Map(withSubs.map(s => [s.uid, s]))
      this.sops = this.sops.map(s => {
        const next = byUid.get(s.uid)
        return next ? { ...s, subtasks: next.subtasks || [] } : s
      })
      const built = buildSopHierarchyTree(this.sops, this.flatNodes)
      this.treeRoots = built.roots || []
      const expanded = { ...this.treeExpanded }
      const walk = (nodes, depth) => {
        (nodes || []).forEach(n => {
          if (expanded[n.uid] == null) expanded[n.uid] = depth < 2
          walk(n.children, depth + 1)
        })
      }
      walk(this.treeRoots, 0)
      this.treeExpanded = expanded
      if (!this.selectedTreeUid && this.treeRoots[0]) {
        this.selectedTreeUid = this.treeRoots[0].uid
      } else if (
        this.selectedTreeUid &&
        this.treeRoots.length &&
        !this.treeContainsUid(this.treeRoots, this.selectedTreeUid)
      ) {
        this.selectedTreeUid = this.treeRoots[0].uid
      }
    },
    treeContainsUid(nodes, uid) {
      for (const n of nodes || []) {
        if (n.uid === uid) return true
        if (this.treeContainsUid(n.children, uid)) return true
      }
      return false
    },
    toggleTreeNode(uid) {
      const open = this.treeExpanded[uid] !== false
      this.$set(this.treeExpanded, uid, !open)
    },
    toggleTreePane() {
      this.treePaneCollapsed = !this.treePaneCollapsed
    },
    selectTreeNode(node) {
      if (!node) return
      this.selectedTreeUid = node.uid
    },
    onSopSearchInput() {
      if (this.sopSearchNorm) {
        // 搜索时自动展开匹配路径（filterHierarchyTreeForSearch 已标 expanded）
        const expandAll = nodes => {
          (nodes || []).forEach(n => {
            this.$set(this.treeExpanded, n.uid, true)
            expandAll(n.children)
          })
        }
        expandAll(this.visibleTreeRoots)
      }
    },
    clearSopSearch() {
      this.sopSearchQuery = ''
    },
    onTreeKeydown(e) {
      const flat = []
      const walk = nodes => {
        (nodes || []).forEach(n => {
          flat.push(n)
          const open =
            n.expanded || this.treeExpanded[n.uid] !== false
          if (open && n.children && n.children.length) walk(n.children)
        })
      }
      walk(this.visibleTreeRoots)
      if (!flat.length) return
      const idx = Math.max(
        0,
        flat.findIndex(n => n.uid === this.selectedTreeUid)
      )
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = flat[Math.min(flat.length - 1, idx + 1)]
        if (next) this.selectedTreeUid = next.uid
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = flat[Math.max(0, idx - 1)]
        if (prev) this.selectedTreeUid = prev.uid
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const cur = flat[idx]
        if (cur && cur.children && cur.children.length) {
          this.$set(this.treeExpanded, cur.uid, true)
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const cur = flat[idx]
        if (cur) this.$set(this.treeExpanded, cur.uid, false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cur = flat[idx]
        const sop = this.sops.find(s => s.uid === (cur && cur.uid))
        if (sop) this.openSubtree(sop)
      }
    },
    async refreshRoomAccess() {
      const roomKey = String(this.roomKey || '').trim()
      if (!roomKey) {
        this.roomRole = null
        this.canEditSop = false
        this.canManageSop = false
        return
      }
      const fromList = this.spaceOptions.find(s => s.room_key === roomKey)
      if (fromList && fromList.role) {
        this.roomRole = fromList.role
        this.canEditSop =
          fromList.canEdit != null
            ? !!fromList.canEdit
            : fromList.role === 'owner' || fromList.role === 'editor'
        this.canManageSop =
          fromList.canManage != null
            ? !!fromList.canManage
            : fromList.role === 'owner'
      }
      try {
        // 用授权接口探测 edit；viewer 得 403，但仍保留查看能力
        await authorizeSopRun(roomKey, '')
        this.canEditSop = true
        if (!this.roomRole || this.roomRole === 'viewer') {
          this.roomRole = this.roomRole === 'owner' ? 'owner' : 'editor'
        }
      } catch (err) {
        if (err && (err.statusCode === 403 || err.code === 'FORBIDDEN')) {
          this.canEditSop = false
          this.canManageSop = false
          if (!this.roomRole) this.roomRole = 'viewer'
        }
      }
    },
    async locateSopInMap(item) {
      const uid = this.resolveSopUid(item)
      if (!this.roomKey || !uid) {
        this.$message.warning('无法定位该 SOP')
        return
      }
      try {
        await locateFileNode(this.roomKey, uid)
      } catch (e) {
        /* locate 可能仅返回坐标，失败时仍打开编辑页 */
      }
      const route = this.$router.resolve({
        path: '/',
        query: { room: this.roomKey, focusUid: uid }
      })
      window.open(route.href, '_blank')
    },
    useCollabV2() {
      return getRuntimeConfig().collabV2 !== false
    },
    teardownPreview() {
      const cooperate = this.previewMindMap && this.previewMindMap.cooperate
      if (this.collabV2Adapter) {
        try {
          if (cooperate && typeof cooperate.setCollabV2Adapter === 'function') {
            cooperate.setCollabV2Adapter(null)
          }
          if (this.collabV2Adapter.disconnect) this.collabV2Adapter.disconnect()
        } catch (e) {
          /* ignore */
        }
        this.collabV2Adapter = null
      }
      if (this.previewMindMap) {
        try {
          this.previewMindMap.destroy()
        } catch (e) {
          /* ignore */
        }
        this.previewMindMap = null
      }
      this.syncStatus = 'idle'
    },
    enableHttpCollab(version) {
      const mindMap = this.previewMindMap
      const cooperate = mindMap && mindMap.cooperate
      const roomKey = this.roomKey
      if (!cooperate || !roomKey) return
      cooperate.setHttpCollab({
        roomKey,
        version: Number(version) || 0,
        fetchSubtree: (uid, options) => getFileSubtree(roomKey, uid, options),
        fetchDeepSubtree: (uid, options) =>
          getFileSubtree(roomKey, uid, {
            deep: true,
            maxNodes: 800,
            ...(options || {})
          }),
        fetchExportTree: () => getFileExport(roomKey),
        fetchNodes: uids => getFileNodes(roomKey, uids),
        fetchLocate: uid => locateFileNode(roomKey, uid),
        fetchOperations: after => getMapOperations(roomKey, after),
        fetchVersion: () => getMapVersion(roomKey),
        undoOperation: operationId => undoMapOperation(roomKey, operationId),
        redoOperation: operationId => redoMapOperation(roomKey, operationId),
        patchNode: (uid, body) =>
          patchFileNode(roomKey, uid, {
            ...(body || {}),
            confirm_sop_change: true
          }),
        addNode: body =>
          addFileNode(roomKey, {
            ...(body || {}),
            confirm_sop_change: true
          }),
        deleteNode: (uid, options) =>
          deleteFileNode(roomKey, uid, {
            ...(options || {}),
            confirm_sop_change: true
          }),
        replaceTree: (tree, extra) =>
          replaceFileTree(roomKey, tree, {
            allowFullTree: true,
            source: 'sop-registry',
            confirm_sop_change: true,
            ...(extra || {})
          })
      })
    },
    ensureCollabV2() {
      if (this.collabV2Adapter) return this.collabV2Adapter
      const cooperate = this.previewMindMap && this.previewMindMap.cooperate
      const clientId = tabClientId()
      const user = this.userInfo
      const adapter = createCollaborationAdapter({
        clientId,
        name: user.name,
        color: user.color,
        createSocket: () => {
          const cfg = getRuntimeConfig()
          const raw = String(cfg.collabApi || '')
            .replace(/^ws/i, 'http')
            .replace(/\/$/, '')
            .replace(/\/collab$/i, '')
          return io(raw || window.location.origin, {
            path: '/collab-v2',
            auth: {
              clientId,
              userId: user.id
            },
            withCredentials: true,
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 8,
            reconnectionDelay: 800,
            reconnectionDelayMax: 15000
          })
        },
        httpSync: async ({ afterRevision }) => {
          const api = getRuntimeConfig().collabApi || ''
          const roomKey = encodeURIComponent(this.roomKey || '')
          const res = await fetch(
            `${api}/api/collab-v2/ops?roomKey=${roomKey}&afterRevision=${Number(
              afterRevision
            ) || 0}`,
            { credentials: 'include', headers: { Accept: 'application/json' } }
          )
          return res.json().catch(() => ({ ok: false }))
        },
        onRemoteOperation: op => {
          if (
            cooperate &&
            typeof cooperate.applyV2RemoteOperation === 'function'
          ) {
            return cooperate.applyV2RemoteOperation(op)
          }
        },
        onReloadRequired: () => {
          if (
            cooperate &&
            typeof cooperate.recoverHttpCollab === 'function'
          ) {
            return cooperate.recoverHttpCollab(
              this.collabV2Adapter &&
                this.collabV2Adapter.getStatus().lastServerRevision
            )
          }
        },
        onRejected: () => {
          this.syncStatus = 'error'
        },
        onLockDenied: owner => {
          this.$message.warning(
            (owner && owner.name ? owner.name : '同事') + ' 正在编辑该节点'
          )
        }
      })
      this.collabV2Adapter = adapter
      if (cooperate && typeof cooperate.setCollabV2Adapter === 'function') {
        cooperate.setCollabV2Adapter(adapter)
      }
      return adapter
    },
    async connectCollabV2(version) {
      if (!this.useCollabV2()) {
        this.syncStatus = 'live'
        return
      }
      this.syncStatus = 'connecting'
      try {
        const adapter = this.ensureCollabV2()
        const ver = Number(version) || 0
        adapter.setLastServerRevision(ver)
        await adapter.connect({
          roomKey: this.roomKey,
          userId: this.userInfo.id,
          clientId: adapter.getClientId && adapter.getClientId(),
          lastServerRevision: ver
        })
        this.syncStatus = 'live'
      } catch (err) {
        console.warn('[sopRegistry] collab v2 connect failed', err)
        this.syncStatus = 'error'
      }
    },
    mountPreviewMindMap(root, version) {
      this.teardownPreview()
      const el = this.$refs.mindMapContainer
      if (!el || !root) return
      // 非导图 tab 时容器可能不可见，先缓存，切回再挂
      if (this.dialogTab !== 'map') {
        this.pendingRoot = root
        this.pendingVersion = Number(version || 0)
        return
      }
      el.innerHTML = ''
      const theme = (exampleData && exampleData.theme) || {}
      this.previewMindMap = new MindMap({
        el,
        data: root,
        fit: true,
        readonly: false,
        layout: (exampleData && exampleData.layout) || 'logicalStructure',
        theme: theme.template || 'default',
        themeConfig: theme.config || {},
        mousewheelAction: 'zoom',
        enableFreeDrag: false,
        initRootNodePosition: ['center', 'center'],
        onlyOneEnableActiveNodeOnCooperate: true
      })
      this.$nextTick(() => {
        try {
          if (this.previewMindMap && this.previewMindMap.view) {
            this.previewMindMap.view.fit()
          }
        } catch (e) {
          /* ignore */
        }
        // 先出图，协同连接放到下一帧，减轻打开卡顿
        const schedule =
          typeof requestAnimationFrame === 'function'
            ? cb => requestAnimationFrame(() => requestAnimationFrame(cb))
            : cb => setTimeout(cb, 0)
        schedule(() => {
          if (!this.previewMindMap) return
          try {
            const cooperate = this.previewMindMap.cooperate
            if (cooperate) {
              if (typeof cooperate.setPreviewApplied === 'function') {
                cooperate.setPreviewApplied(true)
              }
              this.enableHttpCollab(version)
              if (typeof cooperate.markTreeUids === 'function') {
                cooperate.markTreeUids(root)
              }
              if (typeof cooperate.seedPreviewHydration === 'function') {
                cooperate.seedPreviewHydration(root)
              }
              if (typeof cooperate.setPreviewApplied === 'function') {
                cooperate.setPreviewApplied(false)
              }
            }
            this.connectCollabV2(version)
          } catch (err) {
            console.warn('[sopRegistry] deferred collab failed', err)
          }
        })
      })
    },
    onDialogOpened() {
      if (this.pendingRoot && !this.subtreeError) {
        this.$nextTick(() => {
          setTimeout(
            () =>
              this.mountPreviewMindMap(this.pendingRoot, this.pendingVersion),
            60
          )
        })
      }
    },
    onDialogClosed() {
      // 兼容旧逻辑：详情已改为全页，关闭时等同离开详情
      if (this.detailMode) this.leaveDetail()
    },
    async openSubtree(item, opts = {}) {
      const uid = this.resolveSopUid(item)
      if (!this.roomKey) {
        this.$message.warning('请先选择空间')
        return
      }
      if (!uid) {
        this.$message.warning('找不到该 SOP 对应的节点')
        return
      }
      const tab = opts.tab || 'runs'
      const prevUid = String(
        (this.$route.query && this.$route.query.sopUid) || ''
      ).trim()
      // 清掉旧详情状态，避免路由守卫误判跳过加载
      if (prevUid !== uid) {
        this._subtreeLoadToken = (this._subtreeLoadToken || 0) + 1
        this.teardownPreview()
        this.pendingRoot = null
        this.subtreeError = ''
        this.subtreeLoading = false
      }
      this.dialogTab = tab
      this.dialogTitle = (item.title || 'SOP') + '（可编辑 · 协同同步）'
      this.activeSop = item
      this.activeSopUid = uid
      const room = String(this.roomKey || '').trim()
      // 只切路由，由 openDetailFromRoute 单路径加载，避免双请求卡顿
      await this.$router
        .push({
          path: '/sop',
          query: { room, sopUid: uid, tab }
        })
        .catch(() => {})
      if (prevUid === uid) {
        await this.loadSubtreeContent(item)
      }
    },
    async loadSubtreeContent(item) {
      const uid = this.resolveSopUid(item)
      if (!uid || !this.roomKey) return
      const loadToken = (this._subtreeLoadToken = (this._subtreeLoadToken || 0) + 1)
      this.activeSop = item
      this.activeSopUid = uid
      this.activeLedger = mergeLedgerSources(readLedgerFromNodeLike(item), {
        frequency: item.frequency,
        runs: item.runs,
        deliverables: item.deliverables
      })
      this.dialogVisible = false
      this.subtreeLoading = true
      this.subtreeError = ''
      this.pendingRoot = null
      this.pendingVersion = 0
      this.teardownPreview()
      try {
        const data = await getFileSubtree(this.roomKey, uid, {
          deep: true,
          maxNodes: 800
        })
        if (loadToken !== this._subtreeLoadToken) return
        const tree = (data && data.tree) || data
        const root = toMindMapTree(tree)
        if (!root) {
          this.subtreeError = '未拉取到子树'
          return
        }
        const nodeData = (root && root.data) || {}
        if (nodeData.sopLedger || nodeData.note) {
          this.activeLedger = mergeLedgerSources(
            readLedgerFromNodeLike(nodeData),
            {
              frequency: item.frequency,
              runs: item.runs,
              deliverables: item.deliverables
            }
          )
        }
        this.pendingRoot = root
        this.pendingVersion = Number((data && data.version) || 0)
        this.subtreeLoading = false
        this.refreshScannedArtifacts()
        // 先让详情壳渲染，再分帧建图
        await this.$nextTick()
        if (loadToken !== this._subtreeLoadToken) return
        const schedule =
          typeof requestAnimationFrame === 'function'
            ? cb => requestAnimationFrame(() => requestAnimationFrame(cb))
            : cb => setTimeout(cb, 0)
        schedule(() => {
          if (loadToken !== this._subtreeLoadToken) return
          if (this.dialogTab === 'map') {
            this.mountPreviewMindMap(root, this.pendingVersion)
          }
        })
        // 清理脏产物放到后台，不阻塞打开
        const rawDels =
          (nodeData.sopLedger && nodeData.sopLedger.deliverables) ||
          item.deliverables ||
          []
        if (
          Array.isArray(rawDels) &&
          rawDels.length > this.activeLedger.deliverables.length
        ) {
          setTimeout(() => {
            if (loadToken !== this._subtreeLoadToken) return
            persistSopLedger(
              this.roomKey,
              this.activeSopUid,
              {
                id: (item && item.id) || '',
                title: (item && item.title) || ''
              },
              this.activeLedger
            )
              .then(() => {
                if (loadToken !== this._subtreeLoadToken) return
                const idx = this.sops.findIndex(
                  s =>
                    this.resolveSopUid(s) === this.activeSopUid || s === item
                )
                if (idx >= 0) {
                  const next = {
                    ...this.sops[idx],
                    deliverables: this.activeLedger.deliverables,
                    sopLedger: normalizeLedger(this.activeLedger)
                  }
                  this.$set(this.sops, idx, next)
                  this.activeSop = next
                }
              })
              .catch(e => {
                console.warn('[sopRegistry] clean junk deliverables failed', e)
              })
          }, 0)
        }
      } catch (err) {
        if (loadToken !== this._subtreeLoadToken) return
        console.error('[sopRegistry subtree]', err)
        this.subtreeError = (err && err.message) || '加载子树失败'
      } finally {
        if (loadToken === this._subtreeLoadToken) {
          this.subtreeLoading = false
        }
      }
    },
    async openDetailFromRoute() {
      const uid = String(
        (this.$route.query && this.$route.query.sopUid) || ''
      ).trim()
      if (!uid || !this.roomKey) return
      const tab = String(
        (this.$route.query && this.$route.query.tab) || 'runs'
      )
      if (tab === 'runs' || tab === 'dels' || tab === 'map') {
        this.dialogTab = tab
      }
      if (this.subtreeLoading && this.activeSopUid === uid) return
      if (
        this.previewMindMap &&
        this.activeSopUid === uid &&
        this.activeSop &&
        this.resolveSopUid(this.activeSop) === uid
      ) {
        return
      }
      let item =
        (this.activeSop && this.resolveSopUid(this.activeSop) === uid
          ? this.activeSop
          : null) ||
        this.sops.find(s => this.resolveSopUid(s) === uid) ||
        null
      if (!item && !this.sops.length) {
        await this.refreshRoomList()
        item = this.sops.find(s => this.resolveSopUid(s) === uid) || null
      }
      if (!item) {
        item = {
          uid,
          title: this.dialogTitle || 'SOP',
          id: 'D',
          frequency: null,
          runs: [],
          deliverables: []
        }
      }
      await this.loadSubtreeContent(item)
    },
    async refreshRoomList() {
      const roomKey = String(this.roomKey || '').trim()
      if (!roomKey) {
        this.sops = []
        this.flatNodes = []
        this.treeRoots = []
        this.statusText = '请选择空间'
        return
      }
      this.pullLoading = true
      this.statusText = '正在抽取 SOP…'
      try {
        await this.refreshRoomAccess()
        const result = await listRoomDRegistrySops(roomKey)
        // 按节点 UID 分别展示，禁止按标题合并
        const unique = fillDefaultCpda({ sops: result.sops || [] }).sops
        this.flatNodes = result.flatNodes || []
        this.sops = this.mergeSopsPreservingRuns(unique)
        this.rebuildHierarchyTree()
        const space =
          (this.spaceOptions.find(s => s.room_key === roomKey) || {}).label ||
          roomKey
        this.statusText = `「${space}」共 ${this.sops.length} 条 SOP`
        if (this.sopRunQueue && this.sopRunQueue.getSnapshot) {
          this.sopQueueSnap = this.sopRunQueue.getSnapshot()
        }
      } catch (err) {
        console.error('[sopRegistry page]', err)
        this.$message.error((err && err.message) || '读取失败')
        this.statusText = '读取失败'
      } finally {
        this.pullLoading = false
      }
    }
  }
}
</script>

<style lang="less" scoped>
.sopPage {
  min-height: calc(100vh - 48px);
  padding: 20px 28px 36px;
  background: var(--ui-bg, #f7f9f8);
  color: var(--ui-text, #17261f);
  box-sizing: border-box;

  /* 台账列表：整页不跟着滚，左右栏各自滚动 */
  &:not(.detailMode) {
    height: 100vh;
    max-height: 100vh;
    min-height: 0;
    padding: 20px 28px 16px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  &.detailMode {
    height: calc(100vh - 52px);
    max-height: calc(100vh - 52px);
    padding: 10px 16px 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .detailTitle {
    font-size: 18px;
    max-width: 52vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sopDetailPage {
    margin-top: 4px;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .detailTabs {
    background: #fff;
    border-radius: 10px;
    padding: 4px 12px 12px;
    border: 1px solid #e4eee9;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;

    /deep/ .el-tabs__header {
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    /deep/ .el-tabs__content {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /deep/ .el-tab-pane {
      height: 100%;
      overflow: hidden;
    }
  }

  .historyPane {
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 10px;
    overflow: hidden;
  }

  .sectionLabel {
    font-size: 13px;
    font-weight: 600;
    color: #17362c;
    margin-bottom: 8px;

    &.inline {
      margin: 0;
    }
  }

  .paneEmpty.soft {
    padding: 16px;
    color: #80948c;
    background: #f3f7f5;
    border-radius: 8px;
  }

  .sopTaskPanel.embedded {
    margin: 0;
    border: 1px solid #e4eee9;
    border-radius: 8px;
    background: #fafcfb;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .mindWrap {
    min-height: calc(100vh - 240px);
  }
}

.sopDetailPage {
  .mindWrap {
    height: calc(100vh - 220px);
    min-height: 360px;
  }
}

.sopPage {
  --sop-primary: #00896c;
  --sop-primary-hover: #007a60;
  --sop-primary-soft: #e8f7f2;
  --sop-link: #2f6fed;
  --sop-border: #e8ecef;
  --sop-text: #1a2332;
  --sop-muted: #8b95a5;

  .sopHeader {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 14px;
    flex-shrink: 0;

    .left,
    .right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .left {
      align-items: flex-start;
    }

    .titleBlock {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-top: 2px;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--sop-text);
      line-height: 1.25;
    }

    .titleSub {
      margin: 0;
      font-size: 12px;
      color: var(--sop-muted);
      line-height: 1.4;
    }

    .spaceLabel {
      font-size: 13px;
      color: #5c6b7a;
      font-weight: 500;
    }

    .spaceSelect {
      width: 360px;
      max-width: 48vw;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      overflow: hidden;

      &.isOpen {
        color: var(--sop-primary);
        border-color: var(--sop-primary);
        box-shadow: 0 0 0 3px rgba(8, 120, 84, 0.12);
      }

      /deep/ .spaceSelectText {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
      }

      /deep/ .spaceSelectCaret {
        margin-left: auto;
        color: #94a3b8;
        flex-shrink: 0;
      }
    }

    .openMapBtn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid var(--sop-border);
      background: #fff;
      color: #334155;
      font-size: 13px;
      font-weight: 500;

      /deep/ span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
    }

    .refreshBtn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 14px;
      border-radius: 8px;
      border: none;
      background: var(--sop-primary) !important;
      border-color: var(--sop-primary) !important;
      font-size: 13px;
      font-weight: 600;

      /deep/ span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      &:hover,
      &:focus {
        background: var(--sop-primary-hover) !important;
        border-color: var(--sop-primary-hover) !important;
      }
    }
  }

  .statusLine {
    margin: 0 0 10px;
    font-size: 13px;
    color: var(--sop-muted);
    line-height: 1.5;
    flex-shrink: 0;
  }

  .runStatus {
    color: var(--sop-primary);
  }

  .viewerHint {
    color: #a15c00;
  }

  .sopWorkspace {
    margin-top: 0;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .sopSearchWrap {
    position: relative;
    margin-bottom: 14px;
    flex-shrink: 0;

    .searchGlyph {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2;
      color: #94a3b8;
      pointer-events: none;
    }

    .sopSearch {
      width: 100%;

      /deep/ .el-input__inner {
        height: 40px;
        line-height: 40px;
        padding-left: 38px;
        border-radius: 10px;
        border-color: var(--sop-border);
        font-size: 14px;
        background: #fff;

        &:focus {
          border-color: var(--sop-primary);
        }
      }
    }
  }

  .searchEmpty {
    margin-top: 28px;
  }

  .sopSplit {
    display: grid;
    grid-template-columns: minmax(260px, 300px) 1fr;
    gap: 16px;
    flex: 1;
    min-height: 0;
    align-items: stretch;
    overflow: hidden;

    &.treeCollapsed {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }

  .sopTreePane {
    border: 1px solid var(--sop-border);
    border-radius: 12px;
    background: #fff;
    padding: 10px 8px 14px;
    height: 100%;
    max-height: 100%;
    min-height: 0;
    overflow: hidden;
    outline: none;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.03);
    display: flex;
    flex-direction: column;
  }

  .treeHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 700;
    color: var(--sop-text);
    padding: 6px 10px 12px;
    flex-shrink: 0;
    gap: 8px;
    width: 100%;
    box-sizing: border-box;
  }

  .treeCollapseBtn {
    width: 28px;
    height: 28px;
    border: 1px solid var(--sop-border);
    border-radius: 8px;
    background: #fff;
    color: #64748b;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;

    &:hover {
      color: var(--sop-primary);
      border-color: #b7dfd2;
      background: var(--sop-primary-soft);
    }
  }

  .sopTree {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .sopCardPane {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: auto;
    padding-right: 2px;
  }

  .cardPaneHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--ui-bg, #f7f9f8);
    padding: 2px 0 8px;
  }

  .branchHeadLeft {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .branchLabel {
    font-size: 15px;
    font-weight: 700;
    color: var(--sop-text);
  }

  .viewToggle {
    display: inline-flex;
    gap: 6px;
  }

  .viewBtn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--sop-border);
    background: #fff;
    font-size: 13px;
    color: #64748b;
    padding: 6px 12px;
    border-radius: 8px;
    cursor: pointer;
    height: 32px;
    line-height: 1;
    transition: all 0.15s ease;
  }

  .viewBtn.active {
    background: var(--sop-primary);
    border-color: var(--sop-primary);
    color: #fff;
    font-weight: 600;
  }

  .emptyState {
    margin-top: 48px;
    text-align: center;
    color: var(--sop-muted);
    font-size: 14px;
    flex-shrink: 0;
  }

  .paneEmpty.soft {
    padding: 36px 12px;
    color: var(--sop-muted);
    font-size: 13px;
    text-align: center;
    border: 1px dashed var(--sop-border);
    border-radius: 12px;
    background: #fafcfb;
  }

  .dCardStack {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .dCard {
    background: #f0f9f7;
    border: 1px solid #d9ebe6;
    border-radius: 14px;
    padding: 18px 18px 14px;
    box-shadow: none;
    cursor: pointer;

    &.blue {
      background: #f0f6ff;
      border-color: #d7e4fb;
    }

    &.green {
      background: #f0f9f7;
      border-color: #d9ebe6;
    }

    &.collapsed {
      padding-bottom: 16px;
    }
  }

  .dCardTop {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }

  .dCardIcon {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: rgba(0, 137, 108, 0.12);
    color: var(--sop-primary);

    /deep/ .sopGlyph {
      color: inherit;
    }

    &.blue {
      background: rgba(47, 111, 237, 0.12);
      color: #2f6fed;
    }

    &.sm {
      width: 36px;
      height: 36px;
      border-radius: 8px;
    }
  }

  .dCardMain {
    min-width: 0;
    flex: 1;
  }

  .dCardTitleRow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    margin-bottom: 6px;
  }

  .dCardTitle {
    margin: 0;
    font-size: 17px;
    font-weight: 700;
    color: var(--sop-text);
    line-height: 1.35;
  }

  .autoRunTip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--sop-primary);
    background: transparent;
    border-radius: 0;
    padding: 0;
    font-weight: 500;
  }

  .dCard.blue .autoRunTip {
    color: #2f6fed;
  }

  .dCardPath {
    font-size: 12px;
    color: var(--sop-muted);
    line-height: 1.45;
    margin-bottom: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dCardMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .dCardMeta .metaChip {
    font-size: 12px;
    color: #5b6b63;
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(0, 0, 0, 0.04);
    border-radius: 999px;
    padding: 3px 10px;

    &.accent {
      color: var(--sop-primary);
      background: rgba(0, 137, 108, 0.1);
      border-color: transparent;
      font-weight: 600;
    }
  }

  .dCard.blue .dCardMeta .metaChip.accent {
    color: #2f6fed;
    background: rgba(47, 111, 237, 0.1);
  }

  .dCardActions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    padding-top: 2px;
  }

  .runBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 34px;
    padding: 0 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    line-height: 1;
    white-space: nowrap;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;

    &:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    &.primary {
      background: var(--sop-primary);
      border: 1px solid var(--sop-primary);
      color: #fff;

      &:hover:not(:disabled) {
        background: var(--sop-primary-hover);
        border-color: var(--sop-primary-hover);
      }

      .runCaret {
        margin-left: 2px;
        opacity: 0.85;
      }
    }

    &.ghost {
      background: #fff;
      border: 1px solid #b7dfd2;
      color: var(--sop-primary);
      height: 30px;
      padding: 0 12px;
      font-weight: 600;

      &:hover:not(:disabled) {
        background: var(--sop-primary-soft);
        border-color: var(--sop-primary);
      }
    }
  }

  .collapseBtn,
  .moreBtn {
    width: 32px;
    height: 32px;
    border: 1px solid var(--sop-border);
    border-radius: 8px;
    background: #fff;
    color: #64748b;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .moreBtn {
    border: 0;
    background: transparent;
    width: 28px;
    height: 28px;
  }

  .linkBtn {
    border: 0;
    background: transparent;
    color: var(--sop-link);
    font-size: 13px;
    font-weight: 500;
    padding: 0 4px;
    cursor: pointer;
    line-height: 1.4;

    &:hover {
      text-decoration: underline;
    }
  }

  .subtaskList {
    margin-top: 14px;
    padding: 4px 0 2px 22px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    position: relative;
  }

  .subtaskRow {
    position: relative;
    display: grid;
    grid-template-columns: 20px minmax(140px, 1.15fr) minmax(200px, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 12px 12px 12px 10px;
    border-radius: 10px;
    background: #fff;
    border: 1px solid #e8ecef;
  }

  .subtaskRow:hover {
    border-color: #d5dde6;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  }

  .subRail {
    position: absolute;
    left: -16px;
    top: -10px;
    bottom: 50%;
    width: 14px;
    border-left: 1.5px solid #d0d7de;
    border-bottom: 1.5px solid #d0d7de;
    border-bottom-left-radius: 6px;
    pointer-events: none;
  }

  .subIcon {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--sop-primary);
  }

  .subMain {
    min-width: 0;
  }

  .subTitle {
    font-size: 14px;
    font-weight: 600;
    color: var(--sop-text);
  }

  .subDesc {
    font-size: 12px;
    color: var(--sop-muted);
    margin-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subMeta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    font-size: 12px;
    color: #6b7a73;
  }

  .subState {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 999px;
    background: #f3f4f6;

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    &.idle {
      color: #8a9690;
    }
    &.active {
      color: var(--sop-primary);
      background: var(--sop-primary-soft);
    }
    &.done {
      color: #2f6fed;
      background: #eff4ff;
    }
    &.partial {
      color: #b45309;
      background: #fff7ed;
    }
    &.fail {
      color: #b91c1c;
      background: #fef2f2;
    }
  }

  .subStat {
    color: #8b95a5;
  }

  .subActions {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
  }

  .dCardFooter {
    margin-top: 12px;
    padding-top: 4px;
    display: flex;
    gap: 8px;
  }

  .dListStack {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .dListGroup {
    border: 1px solid var(--sop-border);
    border-radius: 12px;
    overflow: hidden;
    background: #fff;
  }

  .dListParent,
  .dListChild {
    display: grid;
    grid-template-columns: 40px minmax(160px, 1.4fr) minmax(180px, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 14px 16px;
    cursor: pointer;
  }

  .dListParent {
    background: #f0f9f7;
    border-bottom: 1px solid #e8f0ed;
  }

  .dListChild {
    background: #fff;
    border-top: 1px solid #f1f4f2;
    padding-left: 28px;
  }

  .listMain {
    min-width: 0;
  }

  .listTitle {
    font-size: 14px;
    font-weight: 700;
    color: var(--sop-text);

    &.sub {
      font-size: 13px;
      font-weight: 600;
    }
  }

  .listPath {
    font-size: 12px;
    color: var(--sop-muted);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .listMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    font-size: 12px;
    color: #6b7a73;
  }

  .listActions {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
  }

  .jobChip {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 999px;
    background: #f3f4f6;
    color: #64748b;

    &.running,
    &.queued {
      color: var(--sop-primary);
      background: var(--sop-primary-soft);
    }
  }

  .dCardTitle /deep/ mark,
  .dCardPath /deep/ mark,
  .subTitle /deep/ mark,
  .listTitle /deep/ mark {
    background: #ffe08a;
    color: inherit;
    padding: 0 1px;
    border-radius: 2px;
  }

  @media (max-width: 1100px) {
    .subtaskRow {
      grid-template-columns: 20px 1fr;
      gap: 8px;
    }

    .subMeta,
    .subActions {
      grid-column: 2;
      justify-content: flex-start;
    }
  }

  @media (max-width: 960px) {
    .sopHeader .right {
      width: 100%;

      .spaceSelect {
        flex: 1;
        width: auto;
        max-width: none;
        min-width: 240px;
      }
    }

    .sopSplit {
      grid-template-columns: 1fr;
      overflow: auto;

      &.treeCollapsed {
        grid-template-columns: 1fr;
      }
    }

    .sopTreePane {
      height: auto;
      max-height: 240px;
    }

    .sopCardPane {
      height: auto;
      max-height: none;
      overflow: visible;
    }

    .dListParent,
    .dListChild {
      grid-template-columns: 1fr;
      gap: 6px;
    }

    .subActions,
    .listActions {
      justify-content: flex-start;
    }
  }

  .cardGrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
    margin-top: 8px;
  }

  .sopTaskPanel {
    margin-top: 20px;
    border: 1px solid var(--ui-border, #e7ece9);
    border-radius: var(--ui-radius-lg, 12px);
    background: var(--ui-surface, #fff);
    overflow: hidden;

    .taskPanelHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--ui-border, #e7ece9);
      background: var(--ui-surface-muted, #f1f5f3);
    }

    .taskTitleRow {
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;

      strong {
        font-size: 14px;
        color: var(--ui-text, #17261f);
      }
    }

    .taskSummary {
      font-size: 12px;
      color: #909399;
    }

    .taskBody {
      display: grid;
      grid-template-columns: minmax(220px, 320px) 1fr;
      min-height: 240px;
      max-height: 520px;
    }

    &.embedded {
      .taskPanelHead {
        flex-shrink: 0;
      }

      .taskBody {
        flex: 1;
        min-height: 0;
        max-height: none;
      }

      .taskDetail {
        overflow: auto;
        min-height: 0;
      }

      .eventList {
        max-height: 100px;
      }

      .streamBox .streamText {
        max-height: 180px;
        min-height: 80px;
      }
    }

    .taskList {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow: auto;
      border-right: 1px solid #ebeef5;
    }

    .taskItem {
      padding: 10px 12px;
      border-bottom: 1px solid #f2f3f5;
      cursor: pointer;

      &:hover,
      &.active {
        background: #f5faf7;
      }

      &.error .taskState {
        color: #f56c6c;
      }

      &.done .taskState {
        color: #67c23a;
      }

      &.running .taskState {
        color: #409eff;
      }

      &.queued .taskState {
        color: #e6a23c;
      }

      &.waiting_data .taskState,
      &.waiting_human .taskState {
        color: #d48806;
      }
    }

    .taskItemMain {
      display: flex;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 4px;
    }

    .taskState {
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 600;
    }

    .taskName {
      font-size: 13px;
      color: #303133;
      word-break: break-word;
    }

    .taskItemStatus {
      font-size: 12px;
      color: #909399;
      line-height: 1.4;
      max-height: 2.8em;
      overflow: hidden;
    }

    .taskItemActions {
      margin-top: 4px;
    }

    .taskDetail {
      padding: 12px 14px;
      overflow: auto;
      min-height: 0;

      .liveHead {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: baseline;
        margin-bottom: 10px;
        font-size: 13px;

        strong {
          flex: 0 1 auto;
          color: #17261f;
        }

        .liveStatus {
          flex: 1 1 auto;
          text-align: right;
          color: #80948c;
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }

      .dataFillCallout {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 12px;
        padding: 12px 14px;
        border: 1px solid #f0d9a8;
        border-radius: 10px;
        background: linear-gradient(180deg, #fffaf0 0%, #fff7e8 100%);
      }

      .calloutMain {
        min-width: 0;
        flex: 1 1 auto;
      }

      .calloutTitle {
        font-size: 13px;
        font-weight: 600;
        color: #8a6116;
        margin-bottom: 4px;
      }

      .calloutHint {
        margin: 0;
        font-size: 12px;
        color: #a07830;
        line-height: 1.45;
      }

      .ctxBox,
      .eventBox,
      .notifyBox,
      .streamBox {
        margin-bottom: 10px;
      }

      .eventList {
        max-height: 120px;
        overflow: auto;
      }

      .streamText {
        max-height: 220px;
        margin: 0;
        padding: 10px;
        overflow: auto;
        background: #f3f7f5;
        color: #24352d;
        border: 1px solid #e7ece9;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
      }
    }
  }

  @media (max-width: 900px) {
    .sopTaskPanel .taskBody {
      grid-template-columns: 1fr;
      max-height: none;
    }

    .sopTaskPanel .taskList {
      border-right: 0;
      border-bottom: 1px solid #ebeef5;
      max-height: 160px;
    }
  }

  .sopCard {
    background: var(--ui-surface, #fff);
    border: 1px solid var(--ui-border, #e7ece9);
    border-radius: var(--ui-radius-lg, 12px);
    padding: 16px;
    box-shadow: 0 1px 2px rgba(23, 38, 31, 0.03);
    cursor: pointer;
    user-select: none;
    transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease;

    &:hover {
      border-color: var(--ui-border-strong, #cbd8d2);
      box-shadow: var(--ui-shadow-hover, 0 6px 18px rgba(23, 38, 31, 0.07));
      transform: translateY(-1px);
    }

    .cardBreadcrumb {
      font-size: 12px;
      color: var(--ui-text-muted, #7b8982);
      line-height: 1.4;
      margin: -4px 0 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .cardFooter {
      display: flex;
      gap: 4px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--ui-border, #e7ece9);
    }

    /deep/ .cardTitle mark,
    /deep/ .cardBreadcrumb mark {
      background: #ffe08a;
      color: inherit;
      padding: 0 1px;
      border-radius: 2px;
    }

    .cardHead {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }

    .cardActions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .jobChip {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #ecf5ff;
      color: #409eff;

      &.running {
        background: #f0f9eb;
        color: #67c23a;
      }

      &.queued {
        background: #fdf6ec;
        color: #e6a23c;
      }

      &.waiting_human {
        background: #fef0f0;
        color: #f56c6c;
      }

      &.waiting_data {
        background: #fdf6ec;
        color: #e6a23c;
      }
    }

    .cardTitle {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--ui-text, #17261f);
      line-height: 1.4;
      word-break: break-word;
      flex: 1;
    }

    .cardMeta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }

    .metaChip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      background: var(--ui-surface-muted, #f1f5f3);
      color: var(--ui-text-secondary, #66756e);
    }

    .cardBlock {
      margin-top: 10px;
    }

    .blockLabel {
      font-size: 12px;
      color: var(--ui-text-muted, #7b8982);
      margin-bottom: 4px;
    }

    .blockBody {
      font-size: 13px;
      color: var(--ui-text-secondary, #66756e);
      line-height: 1.5;
      word-break: break-word;
    }
  }
}
</style>

<style lang="less">
.sopMindDialog,
.sopDetailPage {
  .el-dialog__body {
    padding: 8px 16px 16px;
  }

  .dialogTabs,
  .detailTabs {
    .el-tabs__header {
      margin-bottom: 10px;
    }
  }

  .syncBar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
    color: #606266;

    .syncDot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #c0c4cc;

      &.connecting {
        background: #e6a23c;
      }
      &.live {
        background: #67c23a;
      }
      &.error {
        background: #f56c6c;
      }
    }

    .syncTip {
      margin-left: auto;
      color: #909399;
    }
  }

  .mindWrap {
    position: relative;
    height: 68vh;
    min-height: 400px;
    border: 1px solid #ebeef5;
    border-radius: 8px;
    overflow: hidden;
    background: #fafbfc;
  }

  .mindMapContainer {
    width: 100%;
    height: 100%;
  }

  .paneEmpty {
    padding: 48px 0;
    text-align: center;
    color: #909399;
    font-size: 14px;
  }

  .emptyState {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #909399;
    z-index: 2;
  }
}



.sopDataFillDialog {
  .el-dialog__body {
    max-height: 62vh;
    overflow: auto;
    padding-top: 12px;
    padding-bottom: 8px;
  }

  .fillDialogLead {
    margin: 0 0 8px;
    font-size: 14px;
    color: #24352d;
    line-height: 1.5;
  }

  .fillDialogHint {
    margin: 0 0 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: #f7faf8;
    border: 1px solid #e7ece9;
    font-size: 12px;
    color: #5f7369;
    line-height: 1.45;
  }

  .fillDialogGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 14px;
    margin-bottom: 14px;
  }

  .fillDialogField {
    label {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 600;
      color: #3d4f46;
    }
  }

  .fillDialogExtra {
    margin-bottom: 4px;

    label {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      color: #5f7369;
    }
  }

  .fillDialogFooter {
    display: inline-flex;
    gap: 8px;
  }
}

@media (max-width: 640px) {
  .sopDataFillDialog .fillDialogGrid {
    grid-template-columns: 1fr;
  }

  .sopRunDialog .runSubmitGrid {
    grid-template-columns: 1fr;
  }
}

.runLivePanel {
  margin-top: 12px;
  border: 1px solid #dce7e1;
  border-radius: 10px;
  background: #f7faf8;
  padding: 10px 12px 12px;

  .liveHead {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: baseline;
    margin-bottom: 8px;
    font-size: 13px;

    strong {
      color: #087854;
    }

    span {
      color: #647c71;
      font-size: 12px;
    }
  }

  .ctxBox {
    margin-bottom: 10px;
    font-size: 12px;
    color: #52665f;

    .ctxMeta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-bottom: 6px;
    }

    details summary {
      cursor: pointer;
      color: #087854;
    }

    .ctxPreview {
      max-height: 140px;
      overflow: auto;
      margin: 6px 0 0;
      padding: 8px;
      background: #fff;
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 11px;
      line-height: 1.45;
    }
  }

  .boxLabel {
    font-size: 12px;
    color: #80948c;
    margin-bottom: 4px;
  }

  .notifyBox {
    margin-bottom: 10px;
  }

  .notifyList {
    list-style: none;
    margin: 0;
    padding: 0;
    background: #fff;
    border-radius: 6px;
    border: 1px solid #e4eee9;

    li {
      padding: 8px 10px;
      border-bottom: 1px solid #eef3f0;

      &:last-child {
        border-bottom: none;
      }

      &.block .notifyKind {
        background: #f3e6d4;
        color: #8a5a12;
      }

      &.fail {
        background: #fff8f7;
      }
    }
  }

  .notifyMain {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 4px;
  }

  .notifyKind {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    background: #e4f3ec;
    color: #0d6b4c;
    font-size: 11px;
  }

  .notifyTo {
    font-weight: 600;
    color: #0b3d2e;
    font-size: 13px;
  }

  .notifyText {
    font-size: 12px;
    color: #314940;
    word-break: break-word;
  }

  .notifyMeta {
    margin-top: 3px;
    font-size: 11px;
    color: #80948c;
  }

  .eventBox {
    margin-bottom: 10px;
  }

  .eventList {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 120px;
    overflow: auto;
    background: #fff;
    border-radius: 6px;

    li {
      display: flex;
      gap: 10px;
      padding: 4px 8px;
      border-bottom: 1px solid #eef3f0;
      font-size: 12px;
    }

    .evTime {
      color: #98a59f;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }

    .evLabel {
      color: #17362c;
      word-break: break-word;
    }
  }

  .streamBox .streamText {
    max-height: 260px;
    min-height: 120px;
    overflow: auto;
    margin: 0;
    padding: 10px;
    background: #f3f7f5;
    color: #24352d;
    border: 1px solid #e7ece9;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .runPreview {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid #ebeef5;

    .previewMeta {
      display: flex;
      gap: 12px;
      font-size: 13px;
      color: #087854;
      margin-bottom: 8px;
    }

    ul {
      margin: 0 0 8px;
      padding-left: 18px;
      font-size: 13px;
    }

    .previewReply {
      max-height: 220px;
      overflow: auto;
      margin: 0;
      padding: 10px;
      background: #f5f7f6;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      color: #606266;
    }
  }
}
</style>

<style lang="less">
/* 强制浅色弹窗：避免 body.isDark 全局样式把弹窗/输入框弄成黑底浅字 */
body.isDark .sopDataFillDialog,
.sopDataFillDialog {
  background: #fff !important;

  .el-dialog__header,
  .el-dialog__body,
  .el-dialog__footer {
    background: #fff !important;
    color: #17261f;
  }

  .el-dialog__title,
  .runDialogLead,
  .runModelLabel,
  .optLabel {
    color: #17261f !important;
  }

  .optHint {
    color: #7b8982 !important;
  }

  .el-input__inner,
  .el-textarea__inner {
    background: #fff !important;
    color: #17261f !important;
    border-color: #d5ddd8 !important;
    caret-color: #17261f;

    &::placeholder {
      color: #98a59f !important;
    }
  }

  .el-checkbox__label {
    color: #17261f !important;
  }

  .el-button {
    background-color: #fff !important;
    color: #17261f !important;
    border-color: #d5ddd8 !important;

    &.el-button--primary {
      background-color: var(--ui-primary, #087854) !important;
      border-color: var(--ui-primary, #087854) !important;
      color: #fff !important;
    }
  }
}

body.isDark .sopMindDialog,
.sopMindDialog {
  background: #fff !important;

  .el-dialog__header,
  .el-dialog__body {
    background: #fff !important;
    color: #17261f;
  }

  .el-dialog__title {
    color: #17261f !important;
  }

  .el-input__inner,
  .el-textarea__inner {
    background: #fff !important;
    color: #17261f !important;
    border-color: #d5ddd8 !important;
  }
}

.sopSpaceDirectoryDropdown {
  padding: 10px;
  width: 600px !important;
  min-width: 0;
  max-width: calc(100vw - 24px);

  .spaceDirectoryPicker {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
  }

  .spaceDirectoryLoading {
    min-height: 92px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #718078;
    font-size: 13px;
  }

  .spaceDirectoryTree {
    max-height: 58vh;
    overflow: auto;
    color: #25342d;
  }

  .el-tree-node__content {
    min-height: 38px;
    height: auto;
    margin: 1px 0;
    padding-right: 8px;
    border-radius: 8px;
  }

  .el-tree-node__content:hover,
  .el-tree-node.is-current > .el-tree-node__content {
    background: #edf8f4;
  }

  .el-tree-node__expand-icon {
    padding: 6px;
    color: #809087;
  }

  // Element UI 已依据 isLeaf 标记出叶节点；只隐藏该类节点预留的展开位，
  // 不通过后代内容判断，从而不会误伤包含脑图的文件夹节点。
  .el-tree-node__expand-icon.is-leaf {
    visibility: hidden;
    pointer-events: none;
  }

  .spaceDirectoryOption {
    width: 100%;
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(0, 210px);
    align-items: center;
    gap: 8px;
  }

  .spaceDirectoryOption > i {
    color: #718078;
    flex-shrink: 0;
  }

  .spaceDirectoryName {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #25342d;
  }

  .spaceDirectoryMeta {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #8a9891;
    font-size: 12px;
    white-space: nowrap;
  }

  // “加载更多”是列表的延续操作：与当前层级同宽、可轻松点击，
  // 默认保持次级视觉，避免和文件夹或脑图节点争夺注意力。
  .spaceDirectoryOption--more {
    display: block;
    margin: 0;
    padding: 0 4px;
    background: transparent;
    color: #087854;
    font-size: 13px;
    font-weight: 400;
    line-height: 38px;
    cursor: pointer;
    transition: color 160ms ease;
  }

  .el-tree-node__content:hover .spaceDirectoryOption--more,
  .el-tree-node.is-current > .el-tree-node__content .spaceDirectoryOption--more {
    color: #056747;
    text-decoration: underline;
  }

  .el-tree-node.is-current > .el-tree-node__content .spaceDirectoryName {
    color: #087854;
    font-weight: 600;
  }
}

@media (max-width: 640px) {
  .sopSpaceDirectoryDropdown {
    width: calc(100vw - 24px) !important;

    .spaceDirectoryOption {
      grid-template-columns: auto minmax(0, 1fr) minmax(0, 132px);
      gap: 6px;
    }
  }
}

</style>

<style lang="less" src="./sopRunDialog.less"></style>
