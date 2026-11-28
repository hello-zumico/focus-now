import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "FocusNowModel.js" as Model

// Bar button and settings panel. The service owns the behavior; this panel is
// only a view over ~/.config/omarchy/focus-now.json.
Panel {
  id: root
  moduleName: "zumico.focus-now"
  ipcTarget: "focus-now.panel"

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("zumico.focus-now") : null
  readonly property var cfg: service ? service.config : Model.normalizeConfig({})
  readonly property bool enabled: !!(service && service.config && service.config.enabled)
  property string activeTab: "expansion"
  // Workspaces tab: which workspace's settings block is showing. Picked via
  // the chips; falls back to the first row when the name isn't in the model.
  property string activeWs: "1"
  readonly property var activeWsRow: {
    var rows = service ? service.workspaceRows : []
    for (var i = 0; i < rows.length; i++)
      if (rows[i].name === activeWs) return rows[i]
    return rows.length ? rows[0] : null
  }

  function percent(value) {
    return Commons.I18n.formatNumber(Math.round(Number(value) * 100)) + "%"
  }

  readonly property string statusText: {
    if (!service || !cfg.enabled) return strings.t("status.off")
    if (cfg.expandMode === "fullscreen") return strings.t("status.fullscreen")
    if (cfg.expandMode === "near") return strings.t("status.near").arg(percent(cfg.widthMultiplier)).arg(percent(cfg.heightMultiplier))
    return strings.t("status.expansionOff")
  }

  // Nerd Font glyph per expansion mode; the disabled state is carried by
  // dimming, not a different glyph.
  readonly property string modeGlyph: {
    if (cfg.expandMode === "fullscreen") return "󰊓"
    if (cfg.expandMode === "near") return "󰋱"
    return "󰋲"
  }

  function setExpansion(mode, checked) {
    if (!root.service) return
    if (checked) root.service.setMode(mode)
    else if (root.cfg.expandMode === mode)
      root.service.setMode(mode === "fullscreen" ? "near" : "off")
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.modeGlyph
    dimmed: !root.enabled
    tooltipText: root.enabled ? strings.t("bar.tooltipOn") : strings.t("bar.tooltipOff")
    onPressed: function(b) {
      if (b === Qt.RightButton) { if (root.service) root.service.setEnabled(!root.enabled) }
      else root.toggle()
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(470))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight)

    content: PanelKeyCatcher {
      anchors.fill: parent
      implicitHeight: column.implicitHeight
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, heroSwitch.implicitHeight)

          PlainText {
            id: heroIcon
            text: root.modeGlyph
            opacity: root.enabled ? 1.0 : 0.45
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroSwitch.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            PlainText {
              text: strings.t("title")
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }
            PlainText {
              text: root.statusText.toUpperCase()
              color: Qt.darker(root.bar.foreground, 1.4)
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              wrapMode: Text.WordWrap
              width: parent.width
            }
            PlainText {
              visible: root.enabled && root.cfg.expandMode === "off"
              width: parent.width
              text: strings.t("hint.expansionOff")
              color: Qt.darker(root.bar.foreground, 1.4)
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          ToggleSwitch {
            id: heroSwitch
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            foreground: root.bar.foreground
            checked: root.enabled
            onToggled: if (root.service) root.service.setEnabled(!root.enabled)
          }
        }

        PanelSeparator { foreground: root.bar.foreground }

        ButtonGroup {
          id: tabs
          foreground: root.bar.foreground
          options: [
            { value: "expansion", label: strings.t("tab.expansion") },
            { value: "behavior", label: strings.t("section.behavior") },
            { value: "workspaces", label: strings.t("tab.workspaces") }
          ]
          value: root.activeTab
          onChanged: function(v) { root.activeTab = v }
        }

        PanelSeparator { foreground: root.bar.foreground }

        Column {
          visible: root.activeTab === "expansion"
          width: parent.width
          spacing: Style.space(10)

          ToggleRow {
            label: strings.t("behavior.near")
            hint: strings.t("behavior.near.hint")
            checked: root.cfg.expandMode === "near"
            onSwitched: root.setExpansion("near", !checked)
          }

          Column {
            visible: root.cfg.expandMode === "near"
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: strings.t("section.multipliers")
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
            }

            StepperRow {
              label: strings.t("row.width")
              hint: strings.t("row.width.hint")
              value: root.percent(root.cfg.widthMultiplier)
              onDecrease: if (root.service) root.service.stepWidth(-1)
              onIncrease: if (root.service) root.service.stepWidth(1)
            }

            StepperRow {
              label: strings.t("row.height")
              hint: strings.t("row.height.hint")
              value: root.percent(root.cfg.heightMultiplier)
              onDecrease: if (root.service) root.service.stepHeight(-1)
              onIncrease: if (root.service) root.service.stepHeight(1)
            }

            StepperRow {
              label: strings.t("row.collapseSize")
              hint: strings.t("row.collapseSize.hint")
              value: root.cfg.collapseSize + " px"
              onDecrease: if (root.service) root.service.stepCollapseSize(-1)
              onIncrease: if (root.service) root.service.stepCollapseSize(1)
            }

            Label {
              width: parent.width
              wrapMode: Text.WordWrap
              text: strings.t("hint.multipliers")
            }
          }

          ToggleRow {
            label: strings.t("behavior.fullscreen")
            hint: strings.t("behavior.fullscreen.hint")
            checked: root.cfg.expandMode === "fullscreen"
            onSwitched: root.setExpansion("fullscreen", !checked)
          }

          ToggleRow {
            visible: root.cfg.expandMode === "fullscreen"
            label: strings.t("behavior.sticky")
            hint: strings.t("behavior.sticky.hint")
            checked: root.cfg.stickyFullscreen
            onSwitched: if (root.service) root.service.setStickyFullscreen(!root.cfg.stickyFullscreen)
          }

          StepperRow {
            visible: root.cfg.expandMode === "fullscreen"
            label: strings.t("row.fullscreenDelay")
            hint: strings.t("row.fullscreenDelay.hint")
            value: root.cfg.fullscreenDelay + " ms"
            onDecrease: if (root.service) root.service.stepFullscreenDelay(-1)
            onIncrease: if (root.service) root.service.stepFullscreenDelay(1)
          }
        }

        Column {
          visible: root.activeTab === "behavior"
          width: parent.width
          spacing: Style.space(10)

          StepperRow {
            label: strings.t("row.hoverDelay")
            hint: strings.t("row.hoverDelay.hint")
            value: root.cfg.hoverDelay + " ms"
            onDecrease: if (root.service) root.service.stepHoverDelay(-1)
            onIncrease: if (root.service) root.service.stepHoverDelay(1)
          }

          ToggleRow {
            visible: root.cfg.hoverFocus
            label: strings.t("behavior.refocus")
            hint: strings.t("behavior.refocus.hint")
            checked: root.cfg.mouseRefocus
            onSwitched: if (root.service) root.service.setMouseRefocus(!root.cfg.mouseRefocus)
          }

          ToggleRow {
            label: strings.t("behavior.animate")
            hint: strings.t("behavior.animate.hint")
            checked: root.cfg.animate
            onSwitched: if (root.service) root.service.setAnimate(!root.cfg.animate)
          }

          StepperRow {
            visible: root.cfg.animate
            label: strings.t("row.animateSpeed")
            hint: strings.t("row.animateSpeed.hint")
            value: root.cfg.animateSpeed > 0 ? root.cfg.animateSpeed + " ms" : strings.t("value.default")
            onDecrease: if (root.service) root.service.stepAnimateSpeed(-1)
            onIncrease: if (root.service) root.service.stepAnimateSpeed(1)
          }
        }

        Column {
          visible: root.activeTab === "workspaces"
          width: parent.width
          spacing: Style.space(10)

          Label {
            width: parent.width
            text: strings.t("ws.desc")
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }

          // Picker strips + a single settings block — only the selected
          // workspace's controls render, so the tab's height never grows
          // with the number of enabled presets (hyprmoncfg-style chips).
          PanelSectionHeader {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: strings.t("tab.workspaces")
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Row {
            id: wsPicker
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: Style.space(7)

            Repeater {
              model: root.service ? root.service.workspaceRows.filter(function(r) { return !r.special }) : []

              delegate: Button {
                text: modelData.name
                selected: !!root.activeWsRow && modelData.name === root.activeWsRow.name
                bordered: true
                opacity: modelData.enabled || selected ? 1.0 : 0.5
                foreground: root.bar.foreground
                onClicked: root.activeWs = modelData.name
              }
            }
          }

          PanelSectionHeader {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: strings.t("ws.special")
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Row {
            id: wsSpecialPicker
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: Style.space(7)

            Repeater {
              model: root.service ? root.service.workspaceRows.filter(function(r) { return r.special }) : []

              delegate: Button {
                text: String(modelData.name).replace("special:", "")
                selected: !!root.activeWsRow && modelData.name === root.activeWsRow.name
                bordered: true
                opacity: modelData.enabled || selected ? 1.0 : 0.5
                foreground: root.bar.foreground
                onClicked: root.activeWs = modelData.name
              }
            }
          }

          PanelSeparator { foreground: root.bar.foreground }

          WorkspaceRow {
            visible: !!root.activeWsRow
            wsName: root.activeWsRow ? root.activeWsRow.name : ""
            presetOn: root.activeWsRow ? root.activeWsRow.enabled : false
            base: root.activeWsRow ? root.activeWsRow.base : "dwindle"
            mode: root.activeWsRow ? root.activeWsRow.mode : "mix"
          }
        }
      }
    }
  }

  component PlainText: Text {
    textFormat: Text.PlainText
    color: root.bar.foreground
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component Label: PlainText {
    opacity: 0.6
  }

  // One workspace's layout preset. The toggle enables the preset; the base
  // chips pick the omarchy layout (Tiling keeps dwindle, Scrolling and
  // Floating hand the workspace to the omarchy modes), and under Tiling the
  // second group picks the flat overlay — Mix keeps dwindle with expansion,
  // Columns/Rows claim the workspace for the lua layouts. The overlay chips
  // are dimmed and inert under Scrolling/Floating.
  component WorkspaceRow: Item {
    id: wsRow
    property string wsName: ""
    property bool presetOn: false
    property string base: "dwindle"
    property string mode: "mix"

    width: parent ? parent.width : 0
    implicitHeight: wsCol.implicitHeight

    Column {
      id: wsCol
      width: parent.width
      spacing: Style.space(6)

      Row {
        anchors.horizontalCenter: parent.horizontalCenter
        height: Math.max(wsLabel.implicitHeight, wsToggle.implicitHeight)
        spacing: Style.space(14)

        PlainText {
          id: wsLabel
          anchors.verticalCenter: parent.verticalCenter
          text: wsRow.wsName
          elide: Text.ElideRight
        }

        ToggleSwitch {
          id: wsToggle
          anchors.verticalCenter: parent.verticalCenter
          foreground: root.bar.foreground
          checked: wsRow.presetOn
          onToggled: if (root.service) root.service.setWorkspacePreset(wsRow.wsName, !wsRow.presetOn)
        }
      }

      ButtonGroup {
        visible: wsRow.presetOn
        anchors.horizontalCenter: parent.horizontalCenter
        foreground: root.bar.foreground
        focusable: wsRow.presetOn
        options: [
          { value: "dwindle", label: strings.t("ws.tiling") },
          { value: "scrolling", label: strings.t("ws.scrolling") },
          { value: "floating", label: strings.t("ws.floating") }
        ]
        value: wsRow.base
        onChanged: function(v) { if (root.service) root.service.setWorkspaceBase(wsRow.wsName, v) }
      }

      ButtonGroup {
        visible: wsRow.presetOn
        anchors.horizontalCenter: parent.horizontalCenter
        foreground: root.bar.foreground
        focusable: wsRow.presetOn && wsRow.base === "dwindle"
        opacity: wsRow.base === "dwindle" ? 1.0 : 0.35
        options: [
          { value: "mix", label: strings.t("ws.mix") },
          { value: "columns", label: strings.t("ws.columns") },
          { value: "rows", label: strings.t("ws.rows") }
        ]
        value: wsRow.mode
        onChanged: function(v) {
          if (root.service && wsRow.base === "dwindle")
            root.service.setWorkspaceLayout(wsRow.wsName, v)
        }
      }
    }
  }

  component ToggleRow: Item {
    id: row
    property string label: ""
    property string hint: ""
    property bool checked: false
    signal switched()

    width: parent ? parent.width : 0
    implicitHeight: Math.max(labels.implicitHeight, toggle.implicitHeight)

    Column {
      id: labels
      anchors.left: parent.left
      anchors.right: toggle.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      PlainText { width: parent.width; text: row.label; elide: Text.ElideRight }
      Label { width: parent.width; text: row.hint; wrapMode: Text.WordWrap }
    }

    ToggleSwitch {
      id: toggle
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      foreground: root.bar.foreground
      checked: row.checked
      onToggled: row.switched()
    }
  }

  component StepperRow: Item {
    id: stepper
    property string label: ""
    property string value: ""
    property string hint: ""
    signal decrease()
    signal increase()

    width: parent ? parent.width : 0
    implicitHeight: Math.max(labels.implicitHeight, plus.implicitHeight)

    Column {
      id: labels
      anchors.left: parent.left
      anchors.right: minus.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      PlainText { width: parent.width; text: stepper.label; elide: Text.ElideRight }
      Label { width: parent.width; text: stepper.hint; wrapMode: Text.WordWrap; visible: stepper.hint !== "" }
    }
    Button {
      id: plus
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(34)
      text: "+"
      fontSize: Style.font.bodySmall
      foreground: root.bar.foreground
      fontFamily: root.bar.fontFamily
      verticalPadding: Style.spacing.controlPaddingY
      bordered: true
      onClicked: stepper.increase()
    }
    PlainText {
      anchors.right: plus.left
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(70)
      horizontalAlignment: Text.AlignHCenter
      text: stepper.value
    }
    Button {
      id: minus
      anchors.right: plus.left
      anchors.rightMargin: Style.space(82)
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(34)
      text: "−"
      fontSize: Style.font.bodySmall
      foreground: root.bar.foreground
      fontFamily: root.bar.fontFamily
      verticalPadding: Style.spacing.controlPaddingY
      bordered: true
      onClicked: stepper.decrease()
    }
  }
}
