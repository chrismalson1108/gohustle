import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
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
import { STRIPE_PUBLISHABLE_KEY } from './src/lib/stripeClient';

import HomeScreen           from './src/screens/HomeScreen';
import EarnScreen           from './src/screens/EarnScreen';
import GigsScreen           from './src/screens/GigsScreen';
import PostJobScreen        from './src/screens/PostJobScreen';
import ProfileScreen        from './src/screens/ProfileScreen';
import JobDetailScreen      from './src/screens/JobDetailScreen';
import ManageBookingsScreen from './src/screens/ManageBookingsScreen';
import EditJobScreen        from './src/screens/EditJobScreen';
import SettingsScreen       from './src/screens/SettingsScreen';
import PayoutSetupScreen    from './src/screens/PayoutSetupScreen';
import AuthScreen           from './src/screens/auth/AuthScreen';
import OnboardingScreen     from './src/screens/onboarding/OnboardingScreen';

import { colors } from './src/theme';

const Tab   = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const DETAIL_OPTS = {
  headerShown: true, title: '',
  headerTransparent: false, headerTintColor: colors.primary,
  headerShadowVisible: false, headerStyle: { backgroundColor: '#fff' },
  headerBackTitleVisible: false,
};

const MANAGE_OPTS = {
  headerShown: false,
};

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="HomeMain"  component={HomeScreen} />
      <Stack.Screen name="JobDetail" component={JobDetailScreen} options={DETAIL_OPTS} />
    </Stack.Navigator>
  );
}

function EarnStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="EarnMain"  component={EarnScreen} />
      <Stack.Screen name="JobDetail" component={JobDetailScreen} options={DETAIL_OPTS} />
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
      <Stack.Screen name="PayoutSetup"    component={PayoutSetupScreen} options={DETAIL_OPTS} />
    </Stack.Navigator>
  );
}

const TAB_ICONS = {
  HomeTab:    ['search',        'search-outline'],
  EarnTab:    ['briefcase',     'briefcase-outline'],
  GigsTab:    ['megaphone',     'megaphone-outline'],
  ProfileTab: ['person-circle', 'person-circle-outline'],
};

// Rendered inside providers so it can read badge counts from context
function AppNavigator() {
  const { earnBadgeCount, profileBadgeCount } = useJobs();

  return (
    <NavigationContainer>
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
            route.name === 'EarnTab'  && earnBadgeCount    > 0 ? earnBadgeCount    :
            route.name === 'GigsTab'  && profileBadgeCount > 0 ? profileBadgeCount :
            undefined,
          tabBarBadgeStyle: { backgroundColor: colors.urgent, fontSize: 10, fontWeight: '800' },
        })}
      >
        <Tab.Screen name="HomeTab"    component={HomeStack}    options={{ title: 'Browse' }} />
        <Tab.Screen name="EarnTab"    component={EarnStack}    options={{ title: 'My Jobs' }} />
        <Tab.Screen name="GigsTab"    component={GigsStack}    options={{ title: 'Hiring' }} />
        <Tab.Screen name="ProfileTab" component={ProfileStack} options={{ title: 'Profile' }} />
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
          <AchievementToast />
        </View>
      </JobsProvider>
    </UserProvider>
  );
}

function RootNavigator() {
  const { session, loading, onboardingDone, markOnboardingDone } = useAuth();
  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (!session) return <AuthScreen />;
  if (!onboardingDone) return <OnboardingScreen onComplete={markOnboardingDone} />;
  return <MainApp />;
}

export default function App() {
  return (
    <StripeProvider publishableKey={STRIPE_PUBLISHABLE_KEY} merchantIdentifier="merchant.com.gohustlr">
      <SafeAreaProvider>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </SafeAreaProvider>
    </StripeProvider>
  );
}
