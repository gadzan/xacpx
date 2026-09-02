import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'xacpx',
  base: '/xacpx/',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',
  themeConfig: {
    // shared across locales
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: {
                buttonText: '搜索文档',
                buttonAriaLabel: '搜索文档'
              },
              modal: {
                noResultsText: '无法找到相关结果',
                resetButtonTitle: '清除查询条件',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭'
                }
              }
            }
          }
        }
      }
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/gadzan/xacpx' }
    ],
    editLink: {
      pattern: 'https://github.com/gadzan/xacpx/edit/main/packages/docs/:path',
      text: 'Edit this page on GitHub'
    }
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      description:
        'Control acpx agent sessions remotely from WeChat, Feishu, Yuanbao, Discord, and other chat channels.',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started' },
          { text: 'Reference', link: '/reference/commands' },
          { text: 'Plugins', link: '/plugins/development' },
          { text: 'Development', link: '/development/code-wiki' }
        ],
        sidebar: {
          '/guide/': [
            {
              text: 'Guide',
              items: [
                { text: 'Getting Started', link: '/guide/getting-started' },
                { text: 'Channel Management', link: '/guide/channel-management' },
                { text: 'Self-Hosting the Relay Hub', link: '/guide/relay-self-hosting' },
                { text: 'Scheduled Tasks', link: '/guide/scheduled-tasks' },
                { text: 'Native Sessions', link: '/guide/native-sessions' },
                { text: 'Group Usage', link: '/guide/group-usage' },
                { text: 'Testing', link: '/guide/testing' }
              ]
            }
          ],
          '/reference/': [
            {
              text: 'Reference',
              items: [
                { text: 'CLI Commands', link: '/reference/cli' },
                { text: 'Commands', link: '/reference/commands' },
                { text: 'Configuration', link: '/reference/configuration' },
                { text: '/config Command', link: '/reference/config-command' },
                { text: 'External MCP Coordinator', link: '/reference/external-mcp' }
              ]
            }
          ],
          '/plugins/': [
            {
              text: 'Plugins',
              items: [
                { text: 'Channel Plugin Development', link: '/plugins/development' },
                { text: 'Feishu Channel', link: '/plugins/feishu' },
                { text: 'Yuanbao Channel', link: '/plugins/yuanbao' },
                { text: 'Discord Channel', link: '/plugins/discord' }
              ]
            }
          ],
          '/development/': [
            {
              text: 'Development',
              items: [
                { text: 'Code Wiki', link: '/development/code-wiki' },
                { text: 'Commands Module', link: '/development/commands-module' },
                { text: 'Daemon Module', link: '/development/daemon-module' },
                { text: 'Contributing', link: '/development/contributing' }
              ]
            }
          ]
        },
        footer: {
          message: 'Released under the MIT License.',
          copyright: 'Copyright © 2026 xacpx contributors'
        }
      }
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      description:
        '通过微信、飞书、元宝、Discord 等聊天频道，远程控制 acpx 上的 agent 会话。',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/getting-started' },
          { text: '参考', link: '/zh/reference/commands' },
          { text: '插件', link: '/zh/plugins/development' },
          { text: '开发', link: '/zh/development/code-wiki' }
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: '指南',
              items: [
                { text: '快速开始', link: '/zh/guide/getting-started' },
                { text: '频道管理', link: '/zh/guide/channel-management' },
                { text: '自托管 Relay Hub', link: '/zh/guide/relay-self-hosting' },
                { text: '定时任务', link: '/zh/guide/scheduled-tasks' },
                { text: '原生会话', link: '/zh/guide/native-sessions' },
                { text: '群组使用', link: '/zh/guide/group-usage' },
                { text: '测试', link: '/zh/guide/testing' }
              ]
            }
          ],
          '/zh/reference/': [
            {
              text: '参考',
              items: [
                { text: 'CLI 命令', link: '/zh/reference/cli' },
                { text: '命令参考', link: '/zh/reference/commands' },
                { text: '配置参考', link: '/zh/reference/configuration' },
                { text: '/config 命令', link: '/zh/reference/config-command' },
                { text: '外部 MCP 协调器', link: '/zh/reference/external-mcp' }
              ]
            }
          ],
          '/zh/plugins/': [
            {
              text: '插件',
              items: [
                { text: '频道插件开发', link: '/zh/plugins/development' },
                { text: '飞书频道', link: '/zh/plugins/feishu' },
                { text: '元宝频道', link: '/zh/plugins/yuanbao' },
                { text: 'Discord 频道', link: '/zh/plugins/discord' }
              ]
            }
          ],
          '/zh/development/': [
            {
              text: '开发',
              items: [
                { text: '代码地图', link: '/zh/development/code-wiki' },
                { text: '命令模块', link: '/zh/development/commands-module' },
                { text: '守护进程模块', link: '/zh/development/daemon-module' },
                { text: '贡献指南', link: '/zh/development/contributing' }
              ]
            }
          ]
        },
        outlineTitle: '本页目录',
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdatedText: '最后更新于',
        returnToTopLabel: '返回顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        footer: {
          message: '基于 MIT 许可证发布。',
          copyright: 'Copyright © 2026 xacpx contributors'
        },
        editLink: {
          pattern: 'https://github.com/gadzan/xacpx/edit/main/packages/docs/:path',
          text: '在 GitHub 上编辑此页'
        }
      }
    }
  }
});