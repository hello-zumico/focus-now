import QtQuick
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

  function percent(value) {
    return Commons.I18n.formatNumber(Math.round(Number(value) * 100)) + "%"
  }

  readonly property string statusText: {
    if (!service || !cfg.enabled) return strings.t("status.off")
    if (cfg.expandMode === "fullscreen") return strings.t("status.fullscreen")
    if (cfg.expandMode === "near") return strings.t("status.near").arg(percent(cfg.widthMultiplier)).arg(percent(cfg.heightMultiplier))
    return strings.t("status.expansionOff")
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
    text: root.enabled ? "󰍉" : "󰍎"
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
    contentWidth: panel.fittedContentWidth(Style.space(400))
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
            text: root.enabled ? "󰍉" : "󰍎"
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

        Column {
          width: parent.width
          spacing: Style.space(10)

          PanelSectionHeader {
            text: strings.t("section.behavior")
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          StepperRow {
            label: strings.t("row.hoverDelay")
            hint: strings.t("row.hoverDelay.hint")
            value: root.cfg.hoverDelay + " ms"
            onDecrease: if (root.service) root.service.stepHoverDelay(-1)
            onIncrease: if (root.service) root.service.stepHoverDelay(1)
          }
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        Column {
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

            Label {
              width: parent.width
              wrapMode: Text.WordWrap
              text: strings.t("hint.multipliers")
            }
          }
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        Column {
          width: parent.width
          spacing: Style.space(10)

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
