import React, { useEffect } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { View, ActivityIndicator } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StripeProvider } from '@stripe/stripe-react-native';

import { AuthProvider, useAuth } from './src/context/AuthContext';
import { UserProvider } from './src/context/UserContext';
import { JobsProvider, useJobs } from './src/context/JobsContext';
import AchievementToast from './src/components/AchievementToast';
import AssistantButton from './src/components/AssistantButton';
import ErrorBoundary from './src/components/ErrorBoundary';
import { STRIPE_PUBLISHABLE_KEY } from './src/lib/stripeClient';
import { registerPushToken, addNotificationResponseListener } from './src/lib/push';
import { identify, track } from './src/lib/analytics';

import HomeScreen           from './src/screens/HomeScreen';
import EarnScreen           from './src/screens/EarnScreen';
import GigsScreen           from './src/screens/GigsScreen';
import PostJobScreen        from './src/screens/PostJobScreen';
import ProfileScreen        from './src/screens/ProfileScreen';
import JobDetailScreen      from './src/screens/JobDetailScreen';
import MarketInsightsScreen from './src/screens/MarketInsightsScreen';
import ManageBookingsScreen from './src/screens/ManageBookingsScreen';
import EditJobScreen        from './src/screens/EditJobScreen';
import SettingsScreen       from './src/screens/SettingsScreen';
import PayoutSetupScreen    from './src/screens/PayoutSetupScreen';
import ExpensesScreen       from './src/screens/ExpensesScreen';
import LegalScreen          from './src/screens/LegalScreen';
import PublicProfileScreen  from './src/screens/PublicProfileScreen';
import FavoritesScreen      from './src/screens/FavoritesScreen';
import SavedGigsScreen      from './src/screens/SavedGigsScreen';
import AvailabilityScreen   from './src/screens/AvailabilityScreen';
import NotificationsScreen  from './src/screens/NotificationsScreen';
import MessagesScreen       from './src/screens/MessagesScreen';
import AuthScreen           from './src/screens/auth/AuthScreen';
import OnboardingScreen     from './src/screens/onboarding/OnboardingScreen';
import ConsentScreen        from './src/screens/ConsentScreen';

import { colors } from './src/theme';

const Tab   = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef();

// Registers this device for push on login and routes notification taps to a tab.
function PushManager() {
  const { user } = useAuth();
  useEffect(() => {
    identify(user?.id || null);
    if (user?.id) registerPushToken(user.id);
  }, [user?.id]);
  useEffect(() => {
    const unsub = addNotificationResponseListener((data) => {
      const tab = data?.tab;
      if (tab && navigationRef.isReady()) navigationRef.navigate(tab);
    });
    return unsub;
  }, []);
  return null;
}

const DETAIL_OPTS = {
  headerShown: true, title: '',
  headerTransparent: false, headerTintColor: colors.primary,
  headerShadowVisible: false, headerStyle: { backgroundColor: '#fff' },
  headerBackButtonDisplayMode: 'minimal', // chevron only — no "GigsMain" label (RN-nav v7)
};

const MANAGE_OPTS = {
  headerShown: false,
};

// Hero pattern for screens that open with their own <GradientHeader underNav>:
// the native bar is transparent, so the gradient runs to the very top of the
// screen and the back button floats over it (iOS 26 draws it in a frosted
// circle, which stays legible over the gradient AND over scrolled content).
// Opaque DETAIL_OPTS here would stack a dead white strip on top of the gradient.
const HERO_OPTS = {
  ...DETAIL_OPTS,
  headerTransparent: true,
  // DETAIL_OPTS paints the bar white — that would cover the gradient. Must be
  // transparent here or the "floating" header renders as an opaque white strip.
  headerStyle: { backgroundColor: 'transparent' },
};

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="HomeMain"  component={HomeScreen} />
      <Stack.Screen name="JobDetail" component={JobDetailScreen} options={DETAIL_OPTS} />
      <Stack.Screen name="MarketInsights" component={MarketInsightsScreen} options={HERO_OPTS} />
      <Stack.Screen name="UserProfile" component={PublicProfileScreen} options={HERO_OPTS} />
    </Stack.Navigator>
  );
}

function EarnStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="EarnMain"  component={EarnScreen} />
      <Stack.Screen name="JobDetail" component={JobDetailScreen} options={DETAIL_OPTS} />
      <Stack.Screen name="UserProfile" component={PublicProfileScreen} options={HERO_OPTS} />
    </Stack.Navigator>
  );
}

function GigsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="GigsMain"  component={GigsScreen} />
      <Stack.Screen name="PostJob"   component={PostJobScreen} options={DETAIL_OPTS} />
      <Stack.Screen name="JobDetail" component={JobDetailScreen} options={DETAIL_OPTS} />
      <Stack.Screen name="EditJob"   component={EditJobScreen} options={DETAIL_OPTS} />
      <Stack.Screen name="UserProfile" component={PublicProfileScreen} options={HERO_OPTS} />
    </Stack.Navigator>
  );
}

function MessagesStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MessagesMain" component={MessagesScreen} />
      <Stack.Screen name="UserProfile" component={PublicProfileScreen} options={HERO_OPTS} />
    </Stack.Navigator>
  );
}

function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="ProfileMain"    component={ProfileScreen} />
      <Stack.Screen name="ManageBookings" component={ManageBookingsScreen} options={MANAGE_OPTS} />
      <Stack.Screen name="EditJob"        component={EditJobScreen} />
      <Stack.Screen name="Settings"       component={SettingsScreen} />
      <Stack.Screen name="Availability"   component={AvailabilityScreen} options={{ ...DETAIL_OPTS, title: 'Availability' }} />
      <Stack.Screen name="Notifications"  component={NotificationsScreen} options={{ ...DETAIL_OPTS, title: 'Alerts' }} />
      <Stack.Screen name="PayoutSetup"    component={PayoutSetupScreen} options={DETAIL_OPTS} />
      <Stack.Screen name="Expenses"       component={ExpensesScreen} options={HERO_OPTS} />
      <Stack.Screen name="Legal"          component={LegalScreen} options={{ ...DETAIL_OPTS, headerShown: true }} />
      <Stack.Screen name="UserProfile"    component={PublicProfileScreen} options={HERO_OPTS} />
      <Stack.Screen name="Favorites"      component={FavoritesScreen} options={{ ...DETAIL_OPTS, headerShown: true, title: 'Saved People' }} />
      <Stack.Screen name="SavedGigs"      component={SavedGigsScreen} options={{ ...DETAIL_OPTS, headerShown: true, title: 'Saved Gigs' }} />
      <Stack.Screen name="JobDetail"      component={JobDetailScreen} options={DETAIL_OPTS} />
    </Stack.Navigator>
  );
}

const TAB_ICONS = {
  HomeTab:     ['search',        'search-outline'],
  EarnTab:     ['briefcase',     'briefcase-outline'],
  GigsTab:     ['megaphone',     'megaphone-outline'],
  MessagesTab: ['chatbubble',    'chatbubble-outline'],
  ProfileTab:  ['person-circle', 'person-circle-outline'],
};

// Rendered inside providers so it can read badge counts from context
function AppNavigator() {
  const { earnBadgeCount, profileBadgeCount, unreadMessages } = useJobs();

  return (
    <NavigationContainer ref={navigationRef}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarIcon: ({ focused, color, size }) => {
            const [on, off] = TAB_ICONS[route.name] || ['ellipse', 'ellipse-outline'];
            return <Ionicons name={focused ? on : off} size={size} color={color} />;
          },
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: '#fff',
            borderTopColor: colors.border,
            paddingBottom: 6,
            height: 64,
          },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
          tabBarBadge:
            route.name === 'EarnTab'     && earnBadgeCount    > 0 ? earnBadgeCount    :
            route.name === 'GigsTab'     && profileBadgeCount > 0 ? profileBadgeCount :
            route.name === 'MessagesTab' && unreadMessages    > 0 ? unreadMessages    :
            undefined,
          tabBarBadgeStyle: { backgroundColor: colors.urgent, fontSize: 10, fontWeight: '800' },
        })}
      >
        <Tab.Screen name="HomeTab"    component={HomeStack}    options={{ title: 'Browse' }} />
        <Tab.Screen name="EarnTab"    component={EarnStack}    options={{ title: 'My Jobs' }} />
        <Tab.Screen name="GigsTab"     component={GigsStack}     options={{ title: 'Hiring' }} />
        <Tab.Screen name="MessagesTab" component={MessagesStack} options={{ title: 'Messages' }} />
        <Tab.Screen name="ProfileTab"  component={ProfileStack}  options={{ title: 'Profile' }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

function MainApp() {
  return (
    <UserProvider>
      <JobsProvider>
        <View style={{ flex: 1, position: 'relative' }}>
          <AppNavigator />
          <AssistantButton />
          <AchievementToast />
          <PushManager />
        </View>
      </JobsProvider>
    </UserProvider>
  );
}

function RootNavigator() {
  const { session, loading, onboardingResolved, onboardingDone, needsTermsAcceptance, markOnboardingDone } = useAuth();
  // With a session present, wait for onboarding/terms state to actually load before
  // routing — otherwise a fresh sign-in flashes MainApp on the optimistic
  // onboardingDone=true default before bouncing to onboarding/consent.
  const gateResolving = loading || (!!session && !onboardingResolved);
  if (gateResolving) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (!session) return <AuthScreen />;
  if (!onboardingDone) return <OnboardingScreen onComplete={markOnboardingDone} />;
  if (needsTermsAcceptance) return <ConsentScreen />;
  return <MainApp />;
}

export default function App() {
  return (
    <StripeProvider publishableKey={STRIPE_PUBLISHABLE_KEY} merchantIdentifier="merchant.com.gohustlr">
      <SafeAreaProvider>
        <ErrorBoundary>
          <AuthProvider>
            <RootNavigator />
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </StripeProvider>
  );
}
