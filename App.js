import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, AppState, Image, Linking, Pressable,
  ScrollView, StatusBar, StyleSheet, Text, View, useWindowDimensions, Platform, Settings,
  SafeAreaView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';

const COLORS = {
  background: '#FDFCF8', text: '#5C5552', sage: '#A3B18A',
  terracotta: '#D4A373', cream: '#E9EDC9', warning: '#E57373',
  white: '#FFFFFF', dark: '#28332C', muted: '#817E76',
};
const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e'];
const GYRO_FLIP_THRESHOLD = 1.8;
const GYRO_RESET_THRESHOLD = 0.5;
const GYRO_COOLDOWN_MS = 1200;
const MOTION_PEAK_THRESHOLD = 0.72;
const MOTION_RELEASE_THRESHOLD = 0.20;
const MOTION_COOLDOWN_MS = 550;
const CHALLENGE_TARGET = 240;
const POINTS_PER_MOVEMENT = 10;
const SUGAR_THRESHOLD = 22.5;
const HISTORY_KEY = 'foodscan-pro.scan-history.v1';
const VOICE_KEY = 'foodscan-pro.voice-enabled.v1';
const HISTORY_LIMIT = 30;

const DEMO_RAW = {
  code: 'DEMO-001', product_name: 'FoodScan Demo Snack',
  nutriments: { 'energy-kcal_100g': 240, sugars_100g: 28, sodium_100g: 0.12 },
  nutriscore_grade: 'd',
  ingredients_text: 'Wheat flour, sugar, milk powder, cocoa',
  allergens_tags: ['en:milk', 'en:gluten'],
  categories_tags: ['en:snacks'], isDemo: true,
};

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeProduct(raw, scannedCode, isDemo = false) {
  const nutriments = raw?.nutriments ?? {};
  const grade = String(raw?.nutriscore_grade ?? '').toUpperCase();
  const name = String(raw?.product_name_en ?? '').trim() || String(raw?.product_name ?? '').trim();
  const ingredients = String(raw?.ingredients_text_en ?? '').trim() || String(raw?.ingredients_text ?? '').trim();
  return {
    code: String(scannedCode),
    catalogCode: String(raw?.code ?? scannedCode),
    name: name || 'Unnamed product',
    image: !isDemo && typeof raw?.image_front_url === 'string' ? raw.image_front_url : null,
    calories: isNumber(nutriments['energy-kcal_100g']) ? nutriments['energy-kcal_100g'] : null,
    sugar: isNumber(nutriments.sugars_100g) ? nutriments.sugars_100g : null,
    sodium: isNumber(nutriments.sodium_100g) ? nutriments.sodium_100g : null,
    grade: /^[A-E]$/.test(grade) ? grade : null,
    ingredients: ingredients || null,
    allergens: Array.isArray(raw?.allergens_tags) ? raw.allergens_tags.filter(x => typeof x === 'string') : [],
    categories: Array.isArray(raw?.categories_tags) ? raw.categories_tags.filter(x => typeof x === 'string') : [],
    quantity: String(raw?.quantity ?? '').trim() || null,
    isDemo,
  };
}

function barcodeCandidates(type, data) {
  const code = typeof data === 'string' ? data.trim() : '';
  if (!BARCODE_TYPES.includes(type) || !/^\d+$/.test(code)) return [];
  if (type === 'ean13' && code.length === 13) {
    return code.startsWith('0') ? [code, code.slice(1)] : [code];
  }
  if (type === 'upc_a' && code.length === 12) return [code, `0${code}`];
  if ((type === 'ean8' || type === 'upc_e') && code.length === 8) return [code];
  return [];
}

function formatValue(value, unit = '') {
  return value === null ? 'Not available' : `${Number(value.toFixed(1))}${unit}`;
}

function readHistory() {
  if (Platform.OS !== 'ios') return [];
  try {
    const saved = JSON.parse(Settings.get(HISTORY_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter(item =>
      item && /^\d{8,13}$/.test(item.code) &&
      (item.status === 'found' || item.status === 'notfound') &&
      (item.status === 'notfound' || (item.product && item.product.code === item.code &&
        typeof item.product.name === 'string'))
    ).slice(0, HISTORY_LIMIT) : [];
  } catch (_) { return []; }
}

function readVoiceEnabled() {
  if (Platform.OS !== 'ios') return true;
  try { return Settings.get(VOICE_KEY) !== false; } catch (_) { return true; }
}

function formatScanDate(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function evaluateWarnings(product, preferences) {
  const tags = product.allergens.map(tag => tag.toLowerCase().replace(/_/g, '-'));
  const contains = pattern => tags.some(tag => pattern.test(tag));
  const milk = contains(/(^|:|-)milk($|-)|dairy|lactose/);
  const nutsSoy = contains(/soy|soya|peanut|groundnut|tree-nut|nuts?|almond|hazelnut|walnut|cashew|pistachio|pecan|macadamia/);
  const categoryText = product.categories.join(' ').toLowerCase();
  const solidCategory = product.isDemo || (
    !/beverage|drink|juice|soda|water|milk-based-drink/.test(categoryText) &&
    /snack|biscuit|cookie|chocolate|cake|cereal|bread|confection|spread|solid-food/.test(categoryText)
  );
  const highSugar = preferences.sugar && solidCategory &&
    product.sugar !== null && product.sugar >= SUGAR_THRESHOLD;
  const messages = [];
  if (preferences.milk && milk) messages.push('Contains milk allergens');
  if (preferences.nutsSoy && nutsSoy) messages.push('Contains nut or soy allergens');
  if (highSugar) messages.push(`High sugar: ${SUGAR_THRESHOLD} grams or more per 100 grams`);
  return {
    messages,
    missingAllergens: tags.length === 0,
    missingSugar: preferences.sugar && product.sugar === null,
    sugarClassificationUnknown: preferences.sugar && product.sugar !== null && !solidCategory,
    speechText: messages.length ? `Warning. ${messages.join('. ')}.` : null,
  };
}

function DataCoverage({ product }) {
  const fields = [
    ['Energy', product.calories !== null],
    ['Sugar', product.sugar !== null],
    ['Ingredients', Boolean(product.ingredients)],
    ['Allergens', product.allergens.length > 0],
    ['Sodium', product.sodium !== null],
  ];
  const available = fields.filter(([, present]) => present).length;
  return (
    <View style={[styles.bento, available < fields.length && styles.bentoCaution]}>
      <Text style={styles.bentoTitle}>Data completeness</Text>
      <Text style={styles.bodyText}>{available} of {fields.length} fields available in {product.isDemo ? 'the demo product' : 'Open Food Facts'}</Text>
      <View style={styles.coverageRow}>
        {fields.map(([label, present]) => (
          <Text key={label} style={[styles.coverageTag, !present && styles.coverageTagMissing]}>
            {label}: {present ? 'Available' : 'Missing'}
          </Text>
        ))}
      </View>
      <Text style={styles.cautionText}>Database entries may be incomplete. Always check the product label for allergens.</Text>
    </View>
  );
}

function safeHaptic(action) {
  try { Promise.resolve(action()).catch(() => {}); } catch (_) { /* unavailable */ }
}

function Button({ label, onPress, variant = 'primary', disabled = false, style }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      disabled={disabled} style={({ pressed }) => [styles.button,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'warning' && styles.buttonWarning,
        disabled && { opacity: 0.5 }, pressed && { opacity: 0.82 }, style]}>
      <Text style={[styles.buttonText, variant === 'secondary' && { color: COLORS.dark }]}>{label}</Text>
    </Pressable>
  );
}

function PreferenceChips({ preferences, onToggle, dark = false }) {
  return (
    <View style={styles.chipRow}>
      {[
        ['milk', 'Milk allergy'], ['nutsSoy', 'Nuts / soy allergy'], ['sugar', 'Limit high sugar'],
      ].map(([key, label]) => (
        <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: preferences[key] }}
          onPress={() => onToggle(key)} style={[styles.chip,
            preferences[key] && styles.chipSelected,
            dark && !preferences[key] && styles.chipDark]}>
          <Text style={[styles.chipText, preferences[key] && { color: COLORS.dark },
            dark && !preferences[key] && { color: COLORS.white }]}>
            {preferences[key] ? '✓ ' : '+ '}{label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function VoiceToggle({ enabled, onToggle, dark = false }) {
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel="Spoken alerts"
      accessibilityState={{ checked: enabled }} onPress={onToggle}
      style={[styles.voiceToggle, dark && styles.voiceToggleDark]}>
      <View style={styles.voiceCopy}>
        <Text style={[styles.voiceTitle, dark && styles.voiceTextDark]}>Spoken alerts</Text>
        <Text style={[styles.voiceHint, dark && styles.voiceTextDark]}>
          {enabled ? 'English voice on' : 'Voice off · on-screen alerts stay visible'}
        </Text>
      </View>
      <View style={[styles.switchTrack, enabled && styles.switchTrackOn]}>
        <View style={[styles.switchThumb, enabled && styles.switchThumbOn]} />
      </View>
    </Pressable>
  );
}

function Scanner({ permission, requestPermission, cameraError, onCameraFailure, onCameraRetry,
  preferences, onToggle, voiceEnabled, onVoiceToggle, onScan, onDemo, onHistory, historyCount, active }) {
  const granted = permission?.granted === true;
  return (
    <View style={styles.scannerRoot}>
      {granted && active && !cameraError && (
        <CameraView style={StyleSheet.absoluteFill} facing="back"
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={onScan} onMountError={onCameraFailure} />
      )}
      <View style={styles.scannerShade} />
      <SafeAreaView style={styles.scannerContent}>
        <View style={styles.scannerHeader}>
          <Text style={styles.brandSmall}>FOODSCAN PRO</Text>
          <Text style={styles.scannerTitle}>Know your food.</Text>
          <Text style={styles.scannerSubtitle}>Scan a barcode to see nutrition facts</Text>
          <Text style={styles.sectionCaptionLight}>WHAT TO WATCH FOR</Text>
          <PreferenceChips preferences={preferences} onToggle={onToggle} dark />
          <VoiceToggle enabled={voiceEnabled} onToggle={onVoiceToggle} dark />
        </View>
        <View style={styles.scannerCenter}>
          {granted && active && !cameraError ? (
            <>
              <View style={styles.scanFrame}><View style={styles.scanLine} /></View>
              <Text style={styles.scanInstruction}>Place the barcode inside the frame</Text>
            </>
          ) : (
            <View style={styles.permissionPanel}>
              <Text style={styles.permissionIcon}>▣</Text>
              <Text style={styles.permissionTitle}>
                {cameraError ? 'Could not open camera' : !permission ? 'Checking camera permission' :
                  granted ? 'Camera paused' : 'Camera access needed'}
              </Text>
              <Text style={styles.permissionBody}>
                {cameraError ? 'Try opening the camera again, or view the demo product.' :
                  permission && !granted ? 'Allow camera access to scan products, or view the demo product.' :
                    'Return to the app to scan again.'}
              </Text>
              {permission && !granted && (
                <Button label={permission.canAskAgain ? 'Allow camera access' : 'Open camera settings'}
                  onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings().catch(() => {})} />
              )}
              {cameraError && <Button label="Try camera again" onPress={onCameraRetry} />}
            </View>
          )}
        </View>
        <View style={styles.scannerBottom}>
          <Text style={styles.scannerHint}>Supports EAN-13, EAN-8, UPC-A and UPC-E</Text>
          <Button label={`Scan history (${historyCount})`} onPress={onHistory} variant="secondary" />
          <Button label="View demo product  ↗" onPress={onDemo} variant="secondary" />
          <Text style={styles.scannerFoot}>Product data from Open Food Facts</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

function ProductArtwork({ product }) {
  const [failed, setFailed] = useState(false);
  if (product.image && !failed) {
    return <Image source={{ uri: product.image }} style={styles.productImage}
      resizeMode="contain" onError={() => setFailed(true)} />;
  }
  return (
    <View style={styles.productPlaceholder}>
      <View style={styles.placeholderCircle}>
        <Text style={styles.placeholderGlyph}>{product.isDemo ? '✦' : '▣'}</Text>
      </View>
      <Text style={styles.placeholderText}>{product.isDemo ? 'DEMO SNACK' : 'NO PRODUCT IMAGE'}</Text>
    </View>
  );
}

function DetailScreen({ product, preferences, onToggle, voiceEnabled, onVoiceToggle,
  onScanAgain, onHistory, active }) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(width - 36, 420);
  const flipValue = useRef(new Animated.Value(0)).current;
  const flipBusy = useRef(false);
  const sideRef = useRef('front');
  const gyroArmed = useRef(true);
  const gyroHits = useRef(0);
  const lastFlip = useRef(0);
  const motionLatched = useRef(false);
  const lastMotion = useRef(0);
  const previousMagnitude = useRef(1);
  const countRef = useRef(0);
  const completedRef = useRef(false);
  const detailMounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const lastGyroUi = useRef(0);
  const lastAccelUi = useRef(0);
  const announcedRef = useRef(null);
  const hapticSignatureRef = useRef(null);
  const voiceEnabledRef = useRef(voiceEnabled);
  voiceEnabledRef.current = voiceEnabled;
  const [side, setSide] = useState('front');
  const [count, setCount] = useState(0);
  const [sensors, setSensors] = useState({ gyro: 0, accel: 1 });
  const [availability, setAvailability] = useState({ gyro: 'checking', accel: 'checking' });
  const warnings = useMemo(() => evaluateWarnings(product, preferences), [product, preferences]);
  const warningSignature = warnings.messages.join('|');
  const points = Math.min(count * POINTS_PER_MOVEMENT, CHALLENGE_TARGET);
  const remaining = CHALLENGE_TARGET - points;

  const flipCard = useCallback(() => {
    if (flipBusy.current) return;
    flipBusy.current = true;
    gyroArmed.current = false;
    lastFlip.current = Date.now();
    safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
    const next = sideRef.current === 'front' ? 'back' : 'front';
    Animated.timing(flipValue, {
      toValue: next === 'back' ? 1 : 0, duration: 520, useNativeDriver: true,
    }).start(({ finished }) => {
      flipBusy.current = false;
      if (finished) { sideRef.current = next; setSide(next); }
    });
  }, [flipValue]);
  const flipCardRef = useRef(flipCard);
  flipCardRef.current = flipCard;

  useEffect(() => {
    if (side !== 'back') {
      announcedRef.current = null;
      hapticSignatureRef.current = null;
      try { Speech.stop(); } catch (_) { /* unavailable */ }
      return;
    }
    if (!warningSignature) {
      announcedRef.current = null;
      hapticSignatureRef.current = null;
      try { Speech.stop(); } catch (_) { /* unavailable */ }
      return;
    }
    if (hapticSignatureRef.current !== warningSignature) {
      hapticSignatureRef.current = warningSignature;
      safeHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
    }
    if (!voiceEnabled) {
      announcedRef.current = null;
      try { Speech.stop(); } catch (_) { /* unavailable */ }
      return;
    }
    if (announcedRef.current === warningSignature) return;
    announcedRef.current = warningSignature;
    let cancelled = false;
    (async () => {
      try {
        await Speech.stop();
        if (!cancelled) Speech.speak(warnings.speechText, { language: 'en-US', rate: 0.92 });
      } catch (_) { /* visible text remains available */ }
    })();
    return () => { cancelled = true; };
  }, [side, warningSignature, warnings.speechText, voiceEnabled]);

  useEffect(() => {
    if (!active) {
      try { Speech.stop(); } catch (_) { /* unavailable */ }
    }
  }, [active]);

  useEffect(() => () => {
    detailMounted.current = false;
    try { Speech.stop(); } catch (_) { /* unavailable */ }
    flipValue.stopAnimation();
  }, [flipValue]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let gyroSubscription;
    let accelSubscription;
    (async () => {
      try {
        if (await Gyroscope.isAvailableAsync()) {
          if (cancelled) return;
          Gyroscope.setUpdateInterval(100);
          setAvailability(value => ({ ...value, gyro: 'available' }));
          gyroSubscription = Gyroscope.addListener(({ y }) => {
            const now = Date.now();
            if (now - lastGyroUi.current >= 300) {
              lastGyroUi.current = now;
              setSensors(value => ({ ...value, gyro: y }));
            }
            if (Math.abs(y) < GYRO_RESET_THRESHOLD) {
              gyroHits.current = 0;
              if (now - lastFlip.current >= GYRO_COOLDOWN_MS) gyroArmed.current = true;
              return;
            }
            if (!gyroArmed.current || now - lastFlip.current < GYRO_COOLDOWN_MS) return;
            gyroHits.current = Math.abs(y) >= GYRO_FLIP_THRESHOLD ? gyroHits.current + 1 : 0;
            if (gyroHits.current >= 2) {
              gyroHits.current = 0;
              gyroArmed.current = false;
              flipCardRef.current();
            }
          });
        } else if (!cancelled) setAvailability(value => ({ ...value, gyro: 'unavailable' }));
      } catch (_) {
        if (!cancelled) setAvailability(value => ({ ...value, gyro: 'unavailable' }));
      }
    })();
    (async () => {
      try {
        if (await Accelerometer.isAvailableAsync()) {
          if (cancelled) return;
          Accelerometer.setUpdateInterval(100);
          setAvailability(value => ({ ...value, accel: 'available' }));
          accelSubscription = Accelerometer.addListener(({ x, y, z }) => {
            const magnitude = Math.sqrt(x * x + y * y + z * z);
            const impulse = Math.abs(magnitude - 1);
            const change = Math.abs(magnitude - previousMagnitude.current);
            previousMagnitude.current = magnitude;
            const now = Date.now();
            if (now - lastAccelUi.current >= 300) {
              lastAccelUi.current = now;
              setSensors(value => ({ ...value, accel: magnitude }));
            }
            if (impulse < MOTION_RELEASE_THRESHOLD) { motionLatched.current = false; return; }
            if (motionLatched.current || now - lastMotion.current < MOTION_COOLDOWN_MS ||
              impulse < MOTION_PEAK_THRESHOLD || change < 0.38 ||
              countRef.current * POINTS_PER_MOVEMENT >= CHALLENGE_TARGET) return;
            motionLatched.current = true;
            lastMotion.current = now;
            countRef.current += 1;
            setCount(countRef.current);
            safeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
            if (countRef.current * POINTS_PER_MOVEMENT >= CHALLENGE_TARGET && !completedRef.current) {
              completedRef.current = true;
              try {
                Promise.resolve(Speech.stop()).then(() => {
                  if (detailMounted.current && activeRef.current && voiceEnabledRef.current) {
                    Speech.speak('Great job! You completed the Motion Challenge.', { language: 'en-US' });
                  }
                }).catch(() => {});
              } catch (_) { /* completion is shown in text */ }
            }
          });
        } else if (!cancelled) setAvailability(value => ({ ...value, accel: 'unavailable' }));
      } catch (_) {
        if (!cancelled) setAvailability(value => ({ ...value, accel: 'unavailable' }));
      }
    })();
    return () => {
      cancelled = true;
      gyroSubscription?.remove();
      accelSubscription?.remove();
    };
  }, [active]);

  const resetChallenge = () => {
    countRef.current = 0;
    completedRef.current = false;
    motionLatched.current = false;
    lastMotion.current = Date.now();
    setCount(0);
  };
  const frontRotation = flipValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const backRotation = flipValue.interpolate({ inputRange: [0, 1], outputRange: ['-180deg', '0deg'] });
  const sugarFraction = product.sugar === null ? 0 : Math.min(product.sugar / 50, 1);

  return (
    <SafeAreaView style={styles.detailsRoot}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.decorCircleOne} /><View style={styles.decorCircleTwo} />
      <ScrollView contentContainerStyle={styles.detailsScroll} showsVerticalScrollIndicator={false}>
        <View style={styles.detailsHeader}>
          <View><Text style={styles.brandSmallDark}>FOODSCAN PRO</Text>
            <Text style={styles.detailsTitle}>Nutrition, in motion.</Text></View>
          <Text style={styles.detailsCode} selectable>{product.code}</Text>
        </View>
        {product.isDemo && <Text style={styles.demoBanner}>DEMO DATA — FOR PREVIEW ONLY</Text>}
        <View style={styles.prefPanel}>
          <Text style={styles.sectionCaption}>WHAT TO WATCH FOR</Text>
          <PreferenceChips preferences={preferences} onToggle={onToggle} />
          <VoiceToggle enabled={voiceEnabled} onToggle={onVoiceToggle} />
        </View>
        <View style={[styles.cardStage, { width: cardWidth }]}>
          <Animated.View style={[styles.cardFace, { transform: [{ perspective: 1000 }, { rotateY: frontRotation }] }]}>
            <View style={styles.frontContent}>
              <View style={styles.cardTopline}><Text style={styles.cardEyebrow}>PRODUCT OVERVIEW</Text>
                <Text style={styles.cardIndex}>01 / 02</Text></View>
              <ProductArtwork product={product} />
              <Text style={styles.productName} numberOfLines={2} adjustsFontSizeToFit>{product.name}</Text>
              {product.quantity && <Text style={styles.quantity} numberOfLines={1}>{product.quantity}</Text>}
              <View style={styles.calorieRow}>
                <View><Text style={styles.metricLabel}>Energy per 100 g</Text>
                  <Text style={styles.calorieValue}>{formatValue(product.calories)}
                    {product.calories !== null && <Text style={styles.metricUnit}> kcal</Text>}
                  </Text></View>
                <View style={styles.gradeBadge}><Text style={styles.gradeLabel}>NUTRI-SCORE</Text>
                  <Text style={styles.gradeValue}>{product.grade ?? '—'}</Text></View>
              </View>
              <View style={styles.sugarBox}>
                <View style={styles.metricLine}><Text style={styles.metricLabel}>Sugar per 100 g</Text>
                  <Text style={styles.metricStrong}>{formatValue(product.sugar, product.sugar === null ? '' : ' g')}</Text></View>
                <View style={styles.sugarTrack}><View style={[styles.sugarFill, { width: `${sugarFraction * 100}%` }]} /></View>
                <Text style={styles.tinyNote}>Bar shows 0–50 g to help compare amounts</Text>
              </View>
              <Button label="Flip for more details  ↗" onPress={flipCard}
                style={[styles.cardButton, styles.frontFlipButton]} />
            </View>
          </Animated.View>
          <Animated.View style={[styles.cardFace, styles.backFace,
            { transform: [{ perspective: 1000 }, { rotateY: backRotation }] }]}>
            <ScrollView contentContainerStyle={styles.backContent} nestedScrollEnabled>
              <View style={styles.cardTopline}><Text style={styles.cardEyebrow}>DETAILS & ALERTS</Text>
                <Text style={styles.cardIndex}>02 / 02</Text></View>
              <Text style={styles.backTitle}>Know before you choose</Text>
              <DataCoverage product={product} />
              <View style={[styles.bento, warnings.messages.length > 0 && styles.bentoWarning]}>
                <Text style={styles.bentoTitle}>Allergens & alerts</Text>
                {warnings.messages.length ? warnings.messages.map(message => (
                  <Text key={message} style={styles.warningText}>●  {message}</Text>
                )) : <Text style={styles.bodyText}>No matching alerts in available data. This does not confirm the product is safe.</Text>}
                {product.allergens.length > 0 && <Text style={styles.bodyText}>
                  Listed allergens: {product.allergens.map(tag => tag.replace(/^[a-z]{2}:/i, '').replace(/-/g, ' ')).join(', ')}
                </Text>}
                {warnings.missingAllergens && <Text style={styles.cautionText}>
                  Allergen data is incomplete. Check the product label.
                </Text>}
                {warnings.missingSugar && <Text style={styles.cautionText}>
                  Sugar data is missing. The high-sugar alert cannot be assessed.
                </Text>}
                {warnings.sugarClassificationUnknown && <Text style={styles.cautionText}>
                  High sugar status is unknown because the product category is unclear.
                </Text>}
                <Text style={styles.tinyNote}>The 22.5 g/100 g sugar threshold is a demo screening guide for solid foods.</Text>
              </View>
              <View style={styles.bento}>
                <Text style={styles.bentoTitle}>Ingredients</Text>
                <Text style={styles.bodyText}>{product.ingredients ?? 'Not available'}</Text>
                <Text style={styles.tinyNote}>Sodium per 100 g: {formatValue(product.sodium, product.sodium === null ? '' : ' g')}</Text>
              </View>
              <View style={styles.bento}>
                <Text style={styles.bentoTitle}>Motion Challenge</Text>
                <Text style={styles.bodyText}>Move your hand or shake gently. Do not shake hard or throw your phone.</Text>
                <View style={styles.challengeNumbers}>
                  <View><Text style={styles.challengeValue}>{count}</Text><Text style={styles.tinyNote}>Moves</Text></View>
                  <View><Text style={styles.challengeValue}>{points}</Text><Text style={styles.tinyNote}>Points earned</Text></View>
                  <View><Text style={styles.challengeValue}>{remaining}</Text><Text style={styles.tinyNote}>Points left</Text></View>
                </View>
                <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${points / CHALLENGE_TARGET * 100}%` }]} /></View>
                <Text style={styles.tinyNote}>Goal: {CHALLENGE_TARGET} Energy Points · {POINTS_PER_MOVEMENT} points per move</Text>
                {remaining === 0 && <Text style={styles.successText}>Great job! You completed the Motion Challenge.</Text>}
                <Button label="Restart challenge" onPress={resetChallenge} variant="secondary" style={styles.smallButton} />
              </View>
              <Button label="Flip to front  ↶" onPress={flipCard} style={styles.cardButton} />
            </ScrollView>
          </Animated.View>
        </View>
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>Gyro Y: {sensors.gyro.toFixed(2)} rad/s</Text>
          <Text style={styles.statusText}>Accel: {sensors.accel.toFixed(2)} g</Text>
        </View>
        {(availability.gyro === 'unavailable' || availability.accel === 'unavailable') &&
          <Text style={styles.sensorUnavailable}>Some sensors are unavailable. You can still use the flip button.</Text>}
        <Button label="Scan history" onPress={onHistory} variant="secondary" style={styles.scanAgainButton} />
        <Button label="Scan another product" onPress={onScanAgain} variant="secondary" style={styles.scanAgainButton} />
      </ScrollView>
    </SafeAreaView>
  );
}

function HistoryScreen({ history, onOpen, onBack, onClear }) {
  const confirmClear = () => Alert.alert('Clear scan history?',
    'This removes saved scans from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear history', style: 'destructive', onPress: onClear },
    ]);
  return (
    <SafeAreaView style={styles.historyRoot}>
      <ScrollView contentContainerStyle={styles.historyContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.brandSmallDark}>FOODSCAN PRO</Text>
        <Text style={styles.historyTitle}>Scan history</Text>
        <Text style={styles.historySubtitle}>Recent barcodes saved on this device. Rescan for the latest data.</Text>
        {history.length === 0 ? (
          <View style={styles.historyEmpty}>
            <Text style={styles.bentoTitle}>No scans yet</Text>
            <Text style={styles.bodyText}>Scan a barcode to see it here later.</Text>
          </View>
        ) : history.map(item => (
          <Pressable key={item.code} accessibilityRole="button"
            accessibilityLabel={`Open ${item.status === 'found' ? item.product.name : 'product not found'}, barcode ${item.code}`}
            onPress={() => onOpen(item)} style={({ pressed }) => [styles.historyItem, pressed && { opacity: 0.75 }]}>
            {item.status === 'found' && item.product.image ?
              <Image source={{ uri: item.product.image }} style={styles.historyImage} resizeMode="contain" /> :
              <View style={styles.historyImageFallback}><Text style={styles.historyImageGlyph}>▣</Text></View>}
            <View style={styles.historyItemCopy}>
              <Text style={styles.historyItemName} numberOfLines={2}>
                {item.status === 'found' ? item.product.name : 'Product not found'}
              </Text>
              <Text style={styles.historyItemMeta}>{item.code}</Text>
              <Text style={styles.historyItemMeta}>{formatScanDate(item.scannedAt)}</Text>
            </View>
            <Text style={styles.historyArrow}>›</Text>
          </Pressable>
        ))}
        <Button label="Back" onPress={onBack} style={styles.historyAction} />
        {history.length > 0 && <Button label="Clear history" onPress={confirmClear}
          variant="secondary" style={styles.historyAction} />}
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState('scanner');
  const [historyReturnPhase, setHistoryReturnPhase] = useState('scanner');
  const [history, setHistory] = useState(readHistory);
  const [voiceEnabled, setVoiceEnabled] = useState(readVoiceEnabled);
  const [preferences, setPreferences] = useState({ milk: false, nutsSoy: false, sugar: false });
  const [product, setProduct] = useState(null);
  const [barcode, setBarcode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [cameraError, setCameraError] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const busy = useRef(false);
  const requestId = useRef(0);
  const controller = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      try { Settings.set({ [HISTORY_KEY]: JSON.stringify(history) }); } catch (_) { /* in-memory fallback */ }
    }
  }, [history]);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      try { Settings.set({ [VOICE_KEY]: voiceEnabled }); } catch (_) { /* in-memory fallback */ }
    }
  }, [voiceEnabled]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => {
      mounted.current = false;
      requestId.current += 1;
      controller.current?.abort();
      subscription.remove();
    };
  }, []);

  const togglePreference = useCallback(key => {
    setPreferences(current => ({ ...current, [key]: !current[key] }));
  }, []);

  const toggleVoice = useCallback(() => setVoiceEnabled(current => !current), []);

  const recordScan = useCallback((code, foundProduct = null) => {
    const entry = { code, status: foundProduct ? 'found' : 'notfound',
      scannedAt: Date.now(), ...(foundProduct ? { product: foundProduct } : {}) };
    setHistory(current => [entry, ...current.filter(item => item.code !== code)].slice(0, HISTORY_LIMIT));
  }, []);

  const showHistory = useCallback(() => {
    setHistoryReturnPhase(phase);
    setPhase('history');
  }, [phase]);

  const openHistoryItem = useCallback(item => {
    busy.current = true;
    setBarcode(item.code);
    setErrorMessage('');
    if (item.status === 'found') {
      setProduct(item.product);
      setPhase('detail');
    } else {
      setProduct(null);
      setPhase('notfound');
    }
  }, []);

  const scanAgain = useCallback(() => {
    requestId.current += 1;
    controller.current?.abort();
    controller.current = null;
    busy.current = false;
    setProduct(null);
    setBarcode('');
    setErrorMessage('');
    setCameraError(false);
    setPhase('scanner');
  }, []);

  const showDemo = useCallback(() => {
    requestId.current += 1;
    controller.current?.abort();
    controller.current = null;
    busy.current = true;
    setProduct(normalizeProduct(DEMO_RAW, DEMO_RAW.code, true));
    setErrorMessage('');
    setPhase('detail');
  }, []);

  const handleScan = useCallback(async ({ type, data }) => {
    if (busy.current || !mounted.current) return;
    const candidates = barcodeCandidates(type, data);
    if (!candidates.length) return;
    busy.current = true;
    const originalCode = candidates[0];
    const id = ++requestId.current;
    const abort = new AbortController();
    controller.current = abort;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 12000);
    setBarcode(originalCode);
    setPhase('loading');
    try {
      let found = null;
      for (const code of candidates) {
        const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=code,product_name,product_name_en,image_front_url,nutriments,nutriscore_grade,ingredients_text,ingredients_text_en,allergens_tags,quantity,categories_tags`;
        const response = await fetch(url, {
          signal: abort.signal,
          headers: { 'User-Agent': 'FoodScanPro/1.0 (Expo Go; university mini project)' },
        });
        if (response.status === 404) continue;
        if (!response.ok) throw new Error('HTTP');
        let payload;
        try { payload = await response.json(); } catch (_) { throw new Error('JSON'); }
        if (payload?.status === 1 && payload?.product && typeof payload.product === 'object') {
          found = normalizeProduct(payload.product, originalCode);
          break;
        }
        if (payload?.status !== 0) throw new Error('JSON');
      }
      if (!mounted.current || requestId.current !== id) return;
      recordScan(originalCode, found);
      if (found) { setProduct(found); setPhase('detail'); }
      else setPhase('notfound');
    } catch (error) {
      if (!mounted.current || requestId.current !== id) return;
      setErrorMessage(timedOut ? 'The lookup timed out. Please try again.' :
        error?.message === 'JSON' ? 'Open Food Facts returned invalid data. Please try again.' :
          'Could not connect to Open Food Facts. Check your internet connection and try again.');
      setPhase('error');
    } finally {
      clearTimeout(timeout);
      if (requestId.current === id) controller.current = null;
    }
  }, [recordScan]);

  return (
    <View style={styles.appRoot}>
      <StatusBar barStyle={phase === 'scanner' ? 'light-content' : 'dark-content'} />
      {phase === 'scanner' && <Scanner permission={permission}
        requestPermission={() => requestPermission().catch(() => setCameraError(true))}
        cameraError={cameraError} onCameraFailure={() => setCameraError(true)}
        onCameraRetry={() => setCameraError(false)}
        preferences={preferences} onToggle={togglePreference}
        voiceEnabled={voiceEnabled} onVoiceToggle={toggleVoice}
        onScan={handleScan} onDemo={showDemo} onHistory={showHistory}
        historyCount={history.length} active={active} />}
      {phase === 'loading' && <SafeAreaView style={styles.centerScreen}>
        <ActivityIndicator size="large" color={COLORS.terracotta} />
        <Text style={styles.stateTitle}>Looking up nutrition facts...</Text>
        <Text style={styles.stateBody} selectable>Barcode {barcode}</Text>
        <Text style={styles.stateBody}>Connecting to Open Food Facts</Text>
      </SafeAreaView>}
      {(phase === 'notfound' || phase === 'error') && <SafeAreaView style={styles.centerScreen}>
        <Text style={styles.stateIcon}>{phase === 'notfound' ? '⌕' : '!'}</Text>
        <Text style={styles.stateTitle}>
          {phase === 'notfound' ? 'Product not found in Open Food Facts' : 'Product lookup failed'}
        </Text>
        <Text style={styles.stateBody} selectable>{phase === 'notfound' ? `Barcode ${barcode}` : errorMessage}</Text>
        <Button label="Scan again" onPress={scanAgain} style={styles.stateButton} />
        <Button label="Scan history" onPress={showHistory} variant="secondary" style={styles.stateButton} />
        <Button label="View demo product" onPress={showDemo} variant="secondary" style={styles.stateButton} />
      </SafeAreaView>}
      {phase === 'history' && <HistoryScreen history={history} onOpen={openHistoryItem}
        onBack={() => setPhase(historyReturnPhase)} onClear={() => setHistory([])} />}
      {phase === 'detail' && product && <DetailScreen key={`${product.isDemo ? 'demo' : 'real'}-${product.code}`}
        product={product} preferences={preferences} onToggle={togglePreference}
        voiceEnabled={voiceEnabled} onVoiceToggle={toggleVoice}
        onScanAgain={scanAgain} onHistory={showHistory} active={active} />}
    </View>
  );
}

const styles = StyleSheet.create({
  appRoot: { flex: 1, backgroundColor: COLORS.background },
  button: { minHeight: 48, backgroundColor: COLORS.dark, borderRadius: 16, alignItems: 'center',
    justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 10 },
  buttonSecondary: { backgroundColor: COLORS.cream },
  buttonWarning: { backgroundColor: COLORS.warning },
  buttonText: { color: COLORS.white, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 8 },
  chip: { borderWidth: 1, borderColor: '#D6D8CD', backgroundColor: '#FFFFFFCC',
    paddingHorizontal: 11, paddingVertical: 9, minHeight: 38, borderRadius: 20 },
  chipSelected: { backgroundColor: COLORS.cream, borderColor: COLORS.sage },
  chipDark: { backgroundColor: '#FFFFFF25', borderColor: '#FFFFFF70' },
  chipText: { color: COLORS.text, fontSize: 12, fontWeight: '700' },
  voiceToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#F4F5EB', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, marginTop: 12,
    minHeight: 55, gap: 12 },
  voiceToggleDark: { backgroundColor: '#FFFFFF24', borderWidth: 1, borderColor: '#FFFFFF50' },
  voiceCopy: { flex: 1 },
  voiceTitle: { color: COLORS.dark, fontSize: 13, fontWeight: '800' },
  voiceHint: { color: COLORS.muted, fontSize: 10, marginTop: 2 },
  voiceTextDark: { color: COLORS.white },
  switchTrack: { width: 44, height: 26, borderRadius: 13, backgroundColor: '#B8BAB2',
    padding: 3, justifyContent: 'center' },
  switchTrackOn: { backgroundColor: COLORS.sage },
  switchThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: COLORS.white },
  switchThumbOn: { alignSelf: 'flex-end' },
  scannerRoot: { flex: 1, backgroundColor: '#353E35' },
  scannerShade: { ...StyleSheet.absoluteFillObject, backgroundColor: '#14201766' },
  scannerContent: { flex: 1, justifyContent: 'space-between' },
  scannerHeader: { backgroundColor: '#233129BD', paddingHorizontal: 22, paddingTop: 18, paddingBottom: 20,
    borderBottomLeftRadius: 30, borderBottomRightRadius: 30 },
  brandSmall: { color: COLORS.cream, fontSize: 11, letterSpacing: 2.5, fontWeight: '800' },
  scannerTitle: { color: COLORS.white, fontSize: 30, fontWeight: '800', paddingTop: 7 },
  scannerSubtitle: { color: '#F4F3E8', fontSize: 14, paddingTop: 4 },
  sectionCaptionLight: { color: '#E9EDC9', fontSize: 12, fontWeight: '700', paddingTop: 20 },
  scannerCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  scanFrame: { width: '88%', maxWidth: 340, height: 190, borderRadius: 24, borderWidth: 3,
    borderColor: COLORS.cream, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF0A' },
  scanLine: { width: '85%', height: 2, backgroundColor: COLORS.terracotta },
  scanInstruction: { color: COLORS.white, fontSize: 15, fontWeight: '700', marginTop: 18,
    textAlign: 'center', backgroundColor: '#172218AA', paddingHorizontal: 16, paddingVertical: 9, borderRadius: 16 },
  scannerBottom: { paddingHorizontal: 24, paddingBottom: 16, gap: 10 },
  scannerHint: { color: '#FFFFFFDD', fontSize: 12, textAlign: 'center' },
  scannerFoot: { color: '#FFFFFFAA', fontSize: 11, textAlign: 'center' },
  permissionPanel: { width: '100%', backgroundColor: '#FDFCF8F2', borderRadius: 24,
    padding: 24, alignItems: 'center', gap: 10 },
  permissionIcon: { color: COLORS.terracotta, fontSize: 40 },
  permissionTitle: { color: COLORS.dark, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  permissionBody: { color: COLORS.text, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  detailsRoot: { flex: 1, backgroundColor: COLORS.background },
  detailsScroll: { alignItems: 'center', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 34, gap: 15 },
  decorCircleOne: { position: 'absolute', width: 290, height: 290, borderRadius: 145,
    backgroundColor: '#E9EDC966', top: 180, right: -130 },
  decorCircleTwo: { position: 'absolute', width: 190, height: 190, borderRadius: 95,
    backgroundColor: '#D4A37333', bottom: 80, left: -90 },
  detailsHeader: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  brandSmallDark: { color: COLORS.terracotta, fontSize: 10, letterSpacing: 2.3, fontWeight: '800' },
  detailsTitle: { color: COLORS.dark, fontSize: 23, fontWeight: '800', paddingTop: 5 },
  detailsCode: { color: COLORS.muted, fontSize: 11, maxWidth: 95, textAlign: 'right' },
  demoBanner: { width: '100%', color: '#8C4C31', backgroundColor: '#F6E5D6',
    borderRadius: 12, overflow: 'hidden', padding: 10, fontSize: 12, fontWeight: '800', textAlign: 'center' },
  prefPanel: { width: '100%' },
  sectionCaption: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  cardStage: { height: 565, alignSelf: 'center' },
  cardFace: { position: 'absolute', width: '100%', height: '100%', backgroundColor: COLORS.white,
    borderRadius: 26, backfaceVisibility: 'hidden', overflow: 'hidden',
    shadowColor: '#40362A', shadowOpacity: 0.14, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
  backFace: { backgroundColor: '#FFFEFB' },
  frontContent: { flex: 1, padding: 20 },
  cardTopline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardEyebrow: { color: COLORS.terracotta, fontSize: 10, letterSpacing: 1.8, fontWeight: '800' },
  cardIndex: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  productImage: { width: '100%', height: 142, marginTop: 12 },
  productPlaceholder: { width: '100%', height: 142, marginTop: 12, borderRadius: 18,
    backgroundColor: '#F3F3EA', alignItems: 'center', justifyContent: 'center' },
  placeholderCircle: { width: 75, height: 75, borderRadius: 38, backgroundColor: COLORS.cream,
    alignItems: 'center', justifyContent: 'center' },
  placeholderGlyph: { fontSize: 38, color: COLORS.terracotta },
  placeholderText: { fontSize: 10, color: COLORS.muted, fontWeight: '800', letterSpacing: 1.5, marginTop: 7 },
  productName: { color: COLORS.dark, fontSize: 21, fontWeight: '800', marginTop: 12, minHeight: 52 },
  quantity: { color: COLORS.muted, fontSize: 12 },
  calorieRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#F7F8F0', borderRadius: 18, padding: 14, marginTop: 10 },
  metricLabel: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  calorieValue: { color: COLORS.dark, fontSize: 28, fontWeight: '800', paddingTop: 3 },
  metricUnit: { color: COLORS.muted, fontSize: 14, fontWeight: '700' },
  gradeBadge: { minWidth: 72, alignItems: 'center', backgroundColor: COLORS.cream,
    padding: 7, borderRadius: 13 },
  gradeLabel: { color: COLORS.text, fontSize: 8, fontWeight: '800' },
  gradeValue: { color: COLORS.dark, fontSize: 27, fontWeight: '900' },
  sugarBox: { marginTop: 14 },
  metricLine: { flexDirection: 'row', justifyContent: 'space-between' },
  metricStrong: { color: COLORS.dark, fontSize: 14, fontWeight: '800' },
  sugarTrack: { height: 8, borderRadius: 5, backgroundColor: '#EFECE4', overflow: 'hidden', marginTop: 9 },
  sugarFill: { height: '100%', backgroundColor: COLORS.terracotta, borderRadius: 5 },
  tinyNote: { color: COLORS.muted, fontSize: 10, lineHeight: 15, marginTop: 5 },
  cardButton: { marginTop: 12 },
  frontFlipButton: { marginTop: 'auto' },
  backContent: { padding: 20, paddingBottom: 24, gap: 11 },
  backTitle: { color: COLORS.dark, fontSize: 23, fontWeight: '800' },
  bento: { backgroundColor: '#F5F6EE', padding: 14, borderRadius: 20, gap: 5 },
  bentoWarning: { backgroundColor: '#FFF0EC' },
  bentoCaution: { backgroundColor: '#FFF8EB' },
  bentoTitle: { color: COLORS.dark, fontSize: 15, fontWeight: '800', marginBottom: 3 },
  coverageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 5 },
  coverageTag: { color: '#45623D', fontSize: 10, fontWeight: '700', backgroundColor: '#E7F0DF',
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: 9 },
  coverageTagMissing: { color: '#8E5A27', backgroundColor: '#F6E5CF' },
  bodyText: { color: COLORS.text, fontSize: 12, lineHeight: 18 },
  warningText: { color: '#B73D3D', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  cautionText: { color: '#9E6529', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  challengeNumbers: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  challengeValue: { color: COLORS.dark, fontSize: 19, fontWeight: '800', fontVariant: ['tabular-nums'] },
  progressTrack: { height: 9, borderRadius: 5, backgroundColor: '#E2E6D5', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: COLORS.sage },
  successText: { color: '#54713D', fontSize: 12, fontWeight: '800' },
  smallButton: { minHeight: 40, marginTop: 5 },
  statusRow: { width: '100%', flexDirection: 'row', justifyContent: 'space-evenly',
    paddingVertical: 10, borderRadius: 14, backgroundColor: '#FFFFFFBB' },
  statusText: { color: COLORS.text, fontSize: 11, fontVariant: ['tabular-nums'] },
  sensorUnavailable: { color: '#9E6529', fontSize: 12, textAlign: 'center' },
  scanAgainButton: { width: '100%' },
  centerScreen: { flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 28, gap: 14, backgroundColor: COLORS.background },
  stateIcon: { color: COLORS.terracotta, fontSize: 58, fontWeight: '800' },
  stateTitle: { color: COLORS.dark, fontSize: 21, fontWeight: '800', textAlign: 'center' },
  stateBody: { color: COLORS.text, fontSize: 14, textAlign: 'center', lineHeight: 22 },
  stateButton: { alignSelf: 'stretch' },
  historyRoot: { flex: 1, backgroundColor: COLORS.background },
  historyContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 34, gap: 12 },
  historyTitle: { color: COLORS.dark, fontSize: 28, fontWeight: '800' },
  historySubtitle: { color: COLORS.muted, fontSize: 13, marginBottom: 7 },
  historyEmpty: { backgroundColor: COLORS.white, borderRadius: 20, padding: 20, gap: 4 },
  historyItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.white,
    borderRadius: 18, padding: 10, gap: 12, minHeight: 82 },
  historyImage: { width: 56, height: 56, borderRadius: 10 },
  historyImageFallback: { width: 56, height: 56, borderRadius: 10,
    backgroundColor: '#F3F3EA', alignItems: 'center', justifyContent: 'center' },
  historyImageGlyph: { color: COLORS.terracotta, fontSize: 27 },
  historyItemCopy: { flex: 1, gap: 2 },
  historyItemName: { color: COLORS.dark, fontSize: 14, fontWeight: '800' },
  historyItemMeta: { color: COLORS.muted, fontSize: 11 },
  historyArrow: { color: COLORS.sage, fontSize: 27, fontWeight: '700' },
  historyAction: { marginTop: 4 },
});
