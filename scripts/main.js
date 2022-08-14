const moduleID = 'pf2-flat-check';

const actorConditionMap = {
    'Blinded': -Infinity, //Just so it gets picked up. DC partially depends on target.
    'Dazzled': 5,
    'N/A': -Infinity //To make sure reduce always runs
};

const targetConditionMap = {
    'Concealed': 5,
    'Hidden': 11,
    'Invisible': 11, //Treated as Undetected
    'Undetected': 11,
    'N/A': -Infinity //To make sure reduce always runs
};


Hooks.once("init", () => {
    game.settings.register(moduleID, 'hideRollValue', {
        name: 'Show "Success" or "Failure" Text',
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });
});

Hooks.on('createChatMessage', async (message, data, userID) => {
    if (game.user.id !== game.users.find(u => u.isGM && u.active).id) return;

    const { token, actor } = message;
    let { item } = message;
    const originUUID = message.data.flags.pf2e?.origin?.uuid;
    if (!item && !message.isDamageRoll && originUUID?.match(/Item.(\w+)/) && RegExp.$1 === 'xxPF2ExUNARMEDxx') {
        const actionIds = originUUID.match(/Item.(\w+)/);
        if (actionIds && actionIds[1]) {
            item = actor?.data.data?.actions.filter((atk) => atk?.type === "strike").filter((a) => a.item.id === actionIds[1]) || null;
        }
    }
    if (!actor || !item) return;
    if (['ancestry', 'effect', 'feat', 'melee', 'weapon'].includes(item.type) && (!message.isRoll || message.isDamageRoll)) return;
    if (item.type === 'spell' && message.isRoll) return;

    const templateData = {};
    const { conditionName, DC } = getCondition(token, null, item.type === 'spell');
    templateData.flatCheckDC = DC ?? 0;
    templateData.actor = { name: token?.name || actor.name, condition: conditionName };

    templateData.targets = [];
    const targets = Array.from(game.users.get(userID).targets);
    let anyTargetUndetected = false;
    for (const target of targets) {
        const { conditionName, DC } = getCondition(token, target, item.type === 'spell');
        if (!conditionName) continue;

        templateData.targets.push({
            name: target.name,
            condition: conditionName
        });

        if (DC > templateData.flatCheckDC) templateData.flatCheckDC = DC;
        if (target.actor.itemTypes?.condition.map(n=>n.name)?.includes('Undetected')) anyTargetUndetected = true;
    }

    if (!templateData.actor.condition && !templateData.targets.length) return;

    const flatCheckRoll = await new Roll('1d20').roll();
    if (game.dice3d) await game.dice3d.showForRoll(flatCheckRoll, game.users.get(userID), true);

    templateData.flatCheckRollResult = !game.settings.get(moduleID, 'hideRollValue')
        ? flatCheckRoll.result
        : flatCheckRoll.result < templateData.flatCheckDC
            ? 'Failure'
            : 'Success';

    templateData.flatCheckRollResultClass =
        flatCheckRoll.result < templateData.flatCheckDC
            ? 'flat-check-failure'
            : 'flat-check-success';

    const content = await renderTemplate(`modules/${moduleID}/templates/flat-check.hbs`, templateData);
    await ChatMessage.create({
        content: content,
        speaker: ChatMessage.getSpeaker({ token, actor, user: game.users.get(userID) }),
        whisper: anyTargetUndetected ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : null,
        blind: anyTargetUndetected
    });
});


function distanceBetween(token0, token1) {
  const ray = new Ray(new PIXI.Point(token0?.x || 0, token0?.y || 0), new PIXI.Point(token1?.x || 0, token1?.y || 0));
  const x = Math.ceil(Math.abs(ray.dx / canvas.dimensions.size));
  const y = Math.ceil(Math.abs(ray.dy / canvas.dimensions.size));
  return Math.floor(Math.min(x, y) + Math.abs(y - x)) * canvas.dimensions.distance;
};


function getCondition(token, target, isSpell) {
    const checkingAttackerConditions = target === null;
    const currentActor = checkingAttackerConditions ? token?.actor : target?.actor;
    const conditionMap = checkingAttackerConditions ? { ...actorConditionMap } : targetConditionMap;
    const attackerBlinded = !!token.actor?.items?.find(i=>i.slug === "blinded");
    const attackerDazzled = !!token.actor?.items?.find(i=>i.slug === "dazzled");
    const attackerHasBlindFight = !!token.actor?.items?.find((i) => i.slug === "blind-fight");
    const attackerHasSeeTheUnseen = !!token.actor?.items?.find((i) => i.slug === "see-the-unseen");
    const attackerHasSuperiorSight = !!token.actor?.items?.find((i) => i.slug === "superior-sight");
    //Approximation of adjacency on a square grid with snap to grid on, ignoring elevation (so as to avoid having to implement the more complex pf2e rules).
    const attackerAdjacent = distanceBetween(token, target) <= 5;
    const attackerEqualOrHigherLevel = (token.actor?.level || -Infinity) >= (target?.actor?.level || Infinity);
    const targetHasMistChild = !!target?.actor?.items?.find(i=>i.slug === "mist-child");
    const attackerHasSenseAllies = !!token?.actor?.items?.find(i=>i.slug === "sense-allies");
    const targetIsAlly = !!target?.actor?.isAllyOf(currentActor);
    const targetWithin60Ft = distanceBetween(token, target) <= 60;

    const conditions = currentActor.itemTypes.condition
      .filter(c => {
          if (checkingAttackerConditions && isSpell) {
              const isStupefy = c.name === game.i18n.localize('PF2E.ConditionTypeStupefied');
              if (isStupefy) return true;
          }
          return Object.keys(conditionMap).includes(c.name);
      })
      .map(c => c.name)
      .sort();

    if (!checkingAttackerConditions && attackerBlinded && !conditions.includes('Hidden')) conditions.push('Hidden');
    if (!checkingAttackerConditions && attackerDazzled && !conditions.includes('Concealed')) conditions.push('Concealed');
    if (!conditions.length) return {};

    conditions.unshift('N/A');

    let stupefyLevel;
    if (conditions.includes(game.i18n.localize('PF2E.ConditionTypeStupefied'))) {
        stupefyLevel = currentActor.itemTypes.condition.find(c => c.name === game.i18n.localize('PF2E.ConditionTypeStupefied'))?.value;
        if (stupefyLevel) conditionMap['Stupefied'] = stupefyLevel + 5;
    }

    let condition = conditions.reduce((acc, current) => {
        let currentDC = conditionMap[current];
        if (checkingAttackerConditions) {
            if (attackerHasBlindFight) {
                if (current === 'Dazzled') currentDC = -Infinity;
            }
        }
        if (!checkingAttackerConditions) {
            if (targetHasMistChild) {
                if (current === 'Hidden') {
                    currentDC = 12;
                } else if (current === 'Concealed') {
                    currentDC = 6;
                }
            }
            if (attackerHasSenseAllies && targetIsAlly && current !== 'Unnoticed' && targetWithin60Ft) {
                if (current === 'Undetected') {
                    current = 'Hidden';
                }
                if (current === 'Hidden') {
                    currentDC = 5;
                }
            }
            if (attackerHasSeeTheUnseen) {
                if (current === 'Undetected' && attackerAdjacent) {
                    current = 'Hidden';
                }
                if (current === 'Hidden') {
                    currentDC = 5;
                }
            }
            if (attackerHasBlindFight) {
                if (current === 'Concealed') {
                    currentDC = -Infinity;
                } else if (current === 'Hidden') {
                    currentDC = 5;
                } else if (current === 'Invisible' || current === 'Undetected') {
                    if (attackerAdjacent && attackerEqualOrHigherLevel) {
                        current = 'Hidden';
                        currentDC = 5;
                    }
                }
            }
            if (attackerHasSuperiorSight) {
                if (current === 'Hidden') currentDC = -Infinity;
                if (current === 'Concealed') currentDC = -Infinity;
                if (current === 'Undetected') currentDC = -Infinity;
            }

        }

        //TODO Bug when attack invisible with blindfight, probably more problems hidden there. The line below gets it wrong when I've changed current. So, either fix line below, or change 'current condition' some better way.
        return conditionMap[acc] > currentDC ? acc : current;
    });
    let DC = conditionMap[condition];
    if (condition === 'Stupefied') condition += ` ${stupefyLevel}`;
    if (DC === -Infinity) return {};
    if (condition === 'N/A') return {};

    return {conditionName: condition, DC};
}
